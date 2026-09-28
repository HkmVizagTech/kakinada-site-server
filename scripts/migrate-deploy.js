#!/usr/bin/env node
/**
 * Boot-time migration runner.
 *
 * `prisma migrate deploy` refuses to do anything once a migration has been
 * recorded as failed (P3009): the failed row sits in `_prisma_migrations`
 * forever and every subsequent boot dies on it, so the container crash-loops
 * even after the broken SQL itself has been fixed.
 *
 * This wrapper runs `migrate deploy`; if that fails with P3009 it reads the
 * failed migration names straight out of Prisma's own error text, marks each
 * one as rolled back, and retries the deploy exactly once. A migration is only
 * ever marked rolled back when Prisma itself reported it as failed, and
 * `resolve --rolled-back` is rejected by Prisma for any migration that is not
 * in a failed state, so a healthy database is never touched.
 *
 * Any other failure (unreachable database, genuinely broken SQL) is passed
 * through unchanged and the process exits non-zero, so the deploy still fails
 * loudly instead of booting against a half-migrated schema.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// Call the prisma CLI that is already in node_modules rather than going through
// npx. npx re-resolves the package on every invocation and prints its "New
// major version of npm available!" notice to STDERR, which the deploy log then
// shows as five red lines on every single boot. Running the local binary
// directly is also one less process per call.
const LOCAL_PRISMA = path.join(
  __dirname,
  '..',
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
);
const HAS_LOCAL_PRISMA = fs.existsSync(LOCAL_PRISMA);
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function prisma(args) {
  const [cmd, argv] = HAS_LOCAL_PRISMA
    ? [LOCAL_PRISMA, args]
    : [NPX, ['prisma', ...args]];
  const res = spawnSync(cmd, argv, {
    encoding: 'utf8',
    // Silence npm's update notifier on the npx fallback path too.
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false', NO_UPDATE_NOTIFIER: '1' },
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return { code: res.status === null ? 1 : res.status, output: stdout + stderr };
}

// Prisma prints: The `20260101000000_init` migration started at ... failed
function failedMigrations(output) {
  const names = new Set();
  const re = /The `([^`]+)` migration started at [^\n]*failed/g;
  let m;
  while ((m = re.exec(output)) !== null) names.add(m[1]);
  return [...names];
}

function main() {
  let run = prisma(['migrate', 'deploy']);
  if (run.code === 0) return 0;

  if (!run.output.includes('P3009')) {
    console.error('[migrate] deploy failed and it is not a stuck-migration error; not retrying.');
    return run.code;
  }

  const stuck = failedMigrations(run.output);
  if (stuck.length === 0) {
    console.error('[migrate] P3009 reported but no migration name could be parsed; not retrying.');
    return run.code;
  }

  console.error(`[migrate] clearing failed migration(s): ${stuck.join(', ')}`);
  for (const name of stuck) {
    const resolved = prisma(['migrate', 'resolve', '--rolled-back', name]);
    if (resolved.code !== 0) {
      console.error(`[migrate] could not mark ${name} as rolled back; aborting.`);
      return resolved.code;
    }
  }

  console.error('[migrate] retrying deploy');
  run = prisma(['migrate', 'deploy']);
  return run.code;
}

process.exit(main());

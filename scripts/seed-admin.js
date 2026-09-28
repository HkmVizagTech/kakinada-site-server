#!/usr/bin/env node
// One-off script: create the first admin user for ISKCON Kakinada.
// Run once: node scripts/seed-admin.js
// Safe to re-run — skips if the email already exists.
//
// Parses .env manually and uses the generated Prisma client, so it works
// from the server dir after `npm install` + `npx prisma generate`. If
// node_modules is empty, run `npm install` first.

const fs = require("fs");
const path = require("path");

// ── Load .env manually (no dotenv dependency needed) ──────────────
const envPath = path.resolve(__dirname, "../.env");
const envRaw = fs.readFileSync(envPath, "utf8");
for (const line of envRaw.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  const key = trimmed.slice(0, eq).trim();
  const val = trimmed.slice(eq + 1).trim();
  if (!process.env[key]) process.env[key] = val;
}

const { prisma } = require("../src/lib/prisma");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL is not set in .env");
  process.exit(1);
}

// Credentials come from .env / environment — never hardcoded, so the
// script can't accidentally ship a public admin password.
const EMAIL = process.env.ADMIN_EMAIL;
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME || "ISKCON Kakinada Admin";

if (!EMAIL || !PASSWORD) {
  console.error("❌ ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env or environment");
  process.exit(1);
}

async function main() {
  console.log("Connecting to PostgreSQL…");
  await prisma.$queryRaw`SELECT 1`;
  console.log("Connected ✓");

  const existing = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (existing) {
    console.log(`⚠️  Admin "${EMAIL}" already exists (role: ${existing.role}). Skipping.`);
    await prisma.$disconnect();
    process.exit(0);
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = await prisma.user.create({
    data: { name: NAME, email: EMAIL, password: hash, role: "admin" },
  });

  console.log(`✅ Admin created!`);
  console.log(`   Email:    ${EMAIL}`);
  console.log(`   Role:     ${user.role}`);
  console.log(`   ID:       ${user.id}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});

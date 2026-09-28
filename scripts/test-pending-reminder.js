#!/usr/bin/env node
// Integration test for the pending-transaction reminder.
//
// Unlike test-mongo-compat.js and test-sql-filter.js, this one NEEDS a
// database — it exercises the real selection query against Postgres, which is
// the part most likely to break and the part a unit test cannot cover. It is
// therefore NOT part of `npm test`; run it with `npm run test:reminders`
// against a scratch database.
//
// No WhatsApp message is ever sent: the provider is stubbed before the service
// is required, so this is safe to run anywhere.
//
// Every case below is a rule the job is supposed to enforce, and each one was
// worth writing down because getting it wrong means either messaging a donor
// twice or messaging someone who already paid.
require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.log("  DATABASE_URL is not set — skipping (this test needs a database).");
  process.exit(0);
}

// Gupshup must look configured, and its sender must be a stub, BEFORE
// pendingReminder.service.js destructures them at require time.
process.env.PENDING_WHATSAPP_PROVIDER = "gupshup";
const gupshup = require("../src/services/gupshup.service");
const sends = [];
let failNext = false;
gupshup.isGupshupConfigured = () => true;
gupshup.sendPendingWhatsappViaGupshup = async (phone, name, amount, seva, options) => {
  if (failNext) throw new Error("stubbed provider failure");
  sends.push({ phone, name, amount, seva, options });
  return { messageId: `stub-${sends.length}` };
};

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const { runPendingReminders } = require("../src/services/pendingReminder.service");

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else fails.push({ name, actual: a, expected: e });
}

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000);
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);

async function mk(overrides) {
  return prisma.donation.create({
    data: {
      donorName: "Test Donor",
      donorMobile: "9000000001",
      amount: 501,
      status: "pending",
      sevaName: "Anna Daan",
      sourcePage: "annadaan",
      createdAt: minutesAgo(30),
      ...overrides,
    },
  });
}

async function reset() {
  await prisma.donation.deleteMany({});
  sends.length = 0;
  failNext = false;
}

(async () => {
  // ── 1. the happy path ────────────────────────────────────────────────────
  await reset();
  const eligible = await mk({});
  let r = await runPendingReminders();
  check("an eligible pending donation is reminded", [r.sent, r.failed, r.skipped], [1, 0, 0]);
  check("the provider was actually called once", sends.length, 1);
  check("it was sent to the donor's number", sends[0].phone, "9000000001");
  check(
    "the flag is set so a second pass cannot double-message",
    (await prisma.donation.findUnique({ where: { id: eligible.id } })).whatsappPendingReminderSent,
    true
  );
  r = await runPendingReminders();
  check("a second run sends nothing", [r.checked, r.sent], [0, 0]);

  // ── 2. the age window ────────────────────────────────────────────────────
  await reset();
  await mk({ createdAt: minutesAgo(1) });   // too fresh: may still be completing
  await mk({ createdAt: hoursAgo(48) });    // too old: donor has forgotten
  r = await runPendingReminders();
  check("a donation younger than the cutoff is left alone", r.checked, 0);
  check("...and one older than the floor is never swept up", r.sent, 0);

  // ── 3. statuses ──────────────────────────────────────────────────────────
  await reset();
  // Distinct numbers on purpose: sharing one would trip the "this donor
  // already paid" suppression in case 5 and mask what is being tested here.
  await mk({ status: "completed", donorMobile: "9000000011" });
  await mk({ status: "cancelled", donorMobile: "9000000012" });
  await mk({ status: "failed", donorMobile: "9000000013" }); // failed DOES get a nudge
  r = await runPendingReminders();
  check("only pending/failed are eligible", [r.checked, r.sent], [1, 1]);

  // ── 4. subscriptions ─────────────────────────────────────────────────────
  await reset();
  await mk({ isRecurring: true });
  r = await runPendingReminders();
  check("a recurring first-charge is not nudged (autopay was authorised)", r.checked, 0);

  // ── 5. the donor already paid on a retry ─────────────────────────────────
  await reset();
  await mk({ status: "failed", donorMobile: "9000000002" });
  await mk({ status: "completed", donorMobile: "919000000002", createdAt: minutesAgo(29) });
  r = await runPendingReminders();
  check("a superseded attempt is suppressed, not messaged", [r.sent, r.skipped], [0, 1]);
  check("...and no message went out", sends.length, 0);

  // ── 6. no phone number ───────────────────────────────────────────────────
  await reset();
  const noPhone = await mk({ donorMobile: null });
  r = await runPendingReminders();
  check("a donation with no mobile sends nothing", r.sent, 0);
  check(
    "...and is marked so it is not re-checked forever",
    (await prisma.donation.findUnique({ where: { id: noPhone.id } })).whatsappPendingReminderSent,
    true
  );

  // ── 7. failure handling ──────────────────────────────────────────────────
  await reset();
  const willFail = await mk({});
  failNext = true;
  r = await runPendingReminders();
  const after = await prisma.donation.findUnique({ where: { id: willFail.id } });
  check("a provider failure is counted", [r.sent, r.failed], [0, 1]);
  check("...the sent flag stays false so it is retried", after.whatsappPendingReminderSent, false);
  check("...the attempt is counted", after.whatsappPendingReminderAttempts, 1);
  check("...and the reason is recorded for the admin", after.whatsappPendingReminderError, "stubbed provider failure");

  // ...until the attempt cap is reached.
  await prisma.donation.update({
    where: { id: willFail.id },
    data: { whatsappPendingReminderAttempts: 3 },
  });
  failNext = false;
  r = await runPendingReminders();
  check("a record past the attempt cap drops out of the batch", r.checked, 0);

  // ── 8. what the donor actually gets ──────────────────────────────────────
  await reset();
  await mk({ sevaName: "Go Seva", amount: 1100, festivalSlug: "govardhan-puja" });
  await runPendingReminders();
  check("the seva name is passed through", sends[0].seva, "Go Seva");
  check("the link points at this donation's own page", sends[0].options.linkSuffix, "annadaan");
  check("the campaign label is derived from the festival slug", sends[0].options.campaignLabel, "Govardhan Puja");

  await reset();
  await prisma.$disconnect();

  console.log(`\n  passed: ${pass}`);
  if (fails.length) {
    console.log(`  FAILED: ${fails.length}\n`);
    for (const f of fails) {
      console.log(`  x ${f.name}`);
      console.log(`      actual:   ${f.actual}`);
      console.log(`      expected: ${f.expected}`);
    }
    process.exit(1);
  }
  console.log("  all pending-reminder tests passed");
})().catch(async (err) => {
  console.error(err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});

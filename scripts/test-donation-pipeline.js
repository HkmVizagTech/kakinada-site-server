#!/usr/bin/env node
// Integration test for the whole post-payment pipeline:
//
//     payment captured -> DCC sync -> receipt number -> receipt PDF -> WhatsApp
//
// Every external call is stubbed, so this NEVER touches the real DCC API and
// NEVER sends a WhatsApp message. It does need a database (it exercises the
// real Prisma queries, which is where this pipeline actually broke), so it is
// not part of `npm test` — run it with `npm run test:pipeline`.
//
// Each case below corresponds to a way this chain has failed or could fail in
// production. The expensive lesson: every link is load-bearing. DCC assigns the
// receipt number, no receipt number means no PDF, and no PDF means the donor
// hears nothing at all after paying.
require("dotenv").config();

if (!process.env.DATABASE_URL) {
  console.log("  DATABASE_URL is not set — skipping (this test needs a database).");
  process.exit(0);
}

process.env.DCC_API_KEY = "test-key";
process.env.GUPSHUP_API_KEY = "test-gupshup";
process.env.GUPSHUP_APP_NAME = "TestApp";
process.env.RECEIPT_WHATSAPP_PROVIDER = "gupshup";

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// ── stubs, installed before the services that capture them ────────────────
const gupshup = require("../src/services/gupshup.service");
const waSends = [];
let waFails = false;
gupshup.sendReceiptWhatsappViaGupshup = async (args) => {
  if (waFails) throw new Error("stubbed WhatsApp failure");
  waSends.push(args);
  return { messageId: `gs-${waSends.length}` };
};

const dccCalls = [];
let dccFails = false;
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  dccCalls.push({ url, body: init && init.body });
  if (dccFails) return { ok: false, status: 500, text: async () => "DCC unavailable", json: async () => ({}) };
  const body = { ReceiptNumber: `DCC/2026/${dccCalls.length}` };
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
};

const dcc = require("../src/services/dcc.service");
const {
  completeDonation,
  sendDonationWhatsAppReceipt,
} = require("../src/services/paymentCompletion.service");
const { generateReceiptBuffer } = require("../src/services/receipt.service");
const { donationModel } = require("../src/models/donation.model");

let pass = 0;
const fails = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass += 1;
  else fails.push({ name, actual: a, expected: e });
}

const mk = (over = {}) =>
  prisma.donation.create({
    data: {
      donorName: "Test Donor",
      donorMobile: "9000000060",
      amount: 5100,
      status: "pending",
      sevaName: "Go Seva",
      type: "Seva",
      razorpayOrderId: `order_${Math.random().toString(36).slice(2, 10)}`,
      ...over,
    },
  });

async function reset() {
  await prisma.donation.deleteMany({});
  waSends.length = 0;
  dccCalls.length = 0;
  waFails = false;
  dccFails = false;
}

(async () => {
  // ── 1. the whole chain ───────────────────────────────────────────────────
  await reset();
  let d = await mk();
  const final = await completeDonation({ donationId: d.id, orderId: d.razorpayOrderId, paymentId: "pay_1" });
  let row = await prisma.donation.findUnique({ where: { id: d.id } });
  check("the donation is marked completed", row.status, "completed");
  check("the gateway payment id is recorded", row.razorpayPaymentId, "pay_1");
  check("DCC was called exactly once", dccCalls.length, 1);
  check("DCC's receipt number is stored", row.receiptNumber, "DCC/2026/1");
  check("the sync is marked synced", row.dccSyncStatus, "synced");
  check("a WhatsApp receipt went out", waSends.length, 1);
  check("...to the donor's number", waSends[0].phone, "9000000060");
  check("...with the amount formatted for the template", waSends[0].amountText, "5,100");
  check("...and a real PDF attached", Buffer.from(waSends[0].pdfBytes.slice(0, 5)).toString(), "%PDF-");
  check("the send is recorded", [!!row.whatsappReceiptSentAt, row.whatsappMessageId], [true, "gs-1"]);
  check("completeDonation returns a document, not an array", Array.isArray(final), false);

  // ── 2. idempotency: Razorpay redelivers webhooks ─────────────────────────
  await completeDonation({ donationId: d.id, orderId: d.razorpayOrderId, paymentId: "pay_1" });
  check("a redelivered webhook does not re-sync DCC", dccCalls.length, 1);
  check("...and does not send a second receipt", waSends.length, 1);

  // ── 3. DCC down: no receipt number, so no message at all ─────────────────
  await reset();
  dccFails = true;
  d = await mk();
  await completeDonation({ donationId: d.id, orderId: d.razorpayOrderId, paymentId: "pay_2" });
  row = await prisma.donation.findUnique({ where: { id: d.id } });
  check("the donation still completes when DCC is down", row.status, "completed");
  check("the DCC failure is recorded for the admin", row.dccSyncStatus, "failed");
  check("...with the reason", !!row.dccSyncError, true);
  check("no receipt number is invented", row.receiptNumber, null);
  check("and NO WhatsApp goes out without a real receipt", waSends.length, 0);

  // ── 4. the admin retries once DCC is back ────────────────────────────────
  dccFails = false;
  const retry = await dcc.syncDonationToDcc(d.id, "pay_2");
  row = await prisma.donation.findUnique({ where: { id: d.id } });
  check("a retry after a DCC outage succeeds", [retry.ok, row.dccSyncStatus], [true, "synced"]);
  check("...and assigns the receipt number", !!row.receiptNumber, true);

  // ── 5. two workers racing must not raise two receipts ────────────────────
  await reset();
  d = await mk();
  const [a, b] = await Promise.all([
    dcc.syncDonationToDcc(d.id, "pay_3"),
    dcc.syncDonationToDcc(d.id, "pay_3"),
  ]);
  check("exactly one concurrent sync wins", [a.ok, b.ok].filter(Boolean).length, 1);
  check("...and DCC is called once, not twice", dccCalls.length, 1);

  // ── 6. a WhatsApp failure must not undo the donation ─────────────────────
  await reset();
  waFails = true;
  d = await mk();
  await completeDonation({ donationId: d.id, orderId: d.razorpayOrderId, paymentId: "pay_4" });
  row = await prisma.donation.findUnique({ where: { id: d.id } });
  check("the payment record survives a WhatsApp failure", [row.status, row.dccSyncStatus], ["completed", "synced"]);
  check("...the receipt number is kept", !!row.receiptNumber, true);
  check("...the error is recorded", !!row.whatsappReceiptError, true);
  check("...and it is NOT marked sent, so a resend is possible", row.whatsappReceiptSentAt, null);

  // ── 7. the admin Resend button ───────────────────────────────────────────
  waFails = false;
  let doc = await donationModel.findById(d.id);
  let res = await sendDonationWhatsAppReceipt(doc, { force: true });
  check("resend after a failure works", res.ok, true);
  doc = await donationModel.findById(d.id);
  res = await sendDonationWhatsAppReceipt(doc);           // no force
  check("an unforced repeat is suppressed", [res.ok, res.reason], [true, "already_sent"]);
  res = await sendDonationWhatsAppReceipt(doc, { force: true });
  check("...but the admin can still force one", res.ok, true);

  // ── 8. receipt PDF ───────────────────────────────────────────────────────
  await reset();
  d = await mk({ status: "completed", receiptNumber: "RJY/T/1", donorName: "Ravi Kumar" });
  const ascii = await generateReceiptBuffer(d.id);
  check("an ASCII receipt is a valid PDF", Buffer.from(ascii.slice(0, 5)).toString(), "%PDF-");

  const tel = await mk({ status: "completed", receiptNumber: "RJY/T/2", donorName: "రవి కుమార్" });
  const telugu = await generateReceiptBuffer(tel.id);
  check("a Telugu receipt is a valid PDF", Buffer.from(telugu.slice(0, 5)).toString(), "%PDF-");
  // Subsetting keeps the Unicode receipt small; without it the whole 23MB font
  // is embedded and every such receipt is ~15MB.
  const mb = telugu.length / 1e6;
  check(`a Telugu receipt stays small (was ${mb.toFixed(2)}MB, must be < 2MB)`, mb < 2, true);

  await reset();
  global.fetch = realFetch;
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
  console.log("  all donation-pipeline tests passed");
})().catch(async (err) => {
  console.error(err);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});

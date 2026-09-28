const fs = require("fs");
const os = require("os");
const path = require("path");
const { donationModel } = require("../models/donation.model");
const { syncDonationToDcc } = require("./dcc.service");
const {
  isWhatsAppConfigured,
  sendTemplateMessageWithAttachment,
} = require("./whatsapp.service");
const { generateReceiptBuffer } = require("./receipt.service");

// Approved Meta template for the receipt-with-PDF message. Confirmed from
// the real approved template: body expects 3 params — donor name
// ({{body_1}}), amount ({{body_2}}), seva/purpose ({{body_3}}).
// Per policy, this is the ONLY WhatsApp message this donation flow ever
// sends — no plain-text fallback when there's no receipt yet (see
// sendDonationWhatsAppReceipt below).
const RECEIPT_TEMPLATE_NAME = process.env.WAPI_RECEIPT_TEMPLATE_NAME || "common_donation_success_reciept";

// Which BSP delivers the receipt, evaluated per call so it is a live rollback
// switch rather than something baked in at module load.
//
//   "gupshup" (default) — the approved DOCUMENT-header template shared with
//              HKM Vizag. It has no buttons, so unlike the pending template it
//              is safe to share across sites: the only site-specific part is
//              the PDF link, which is uploaded to this site's own R2 bucket.
//   "flaxxa"           — the original path, which posts the PDF as binary
//              multipart to the Flaxxa number.
const RECEIPT_PROVIDER = () =>
  String(process.env.RECEIPT_WHATSAPP_PROVIDER || "gupshup").toLowerCase();

// Whether the ACTIVE receipt provider is usable. The admin "Resend WhatsApp"
// button used to test WAPI_TOKEN unconditionally, so on a server sending
// through Gupshup it always answered "WhatsApp isn't connected yet" and
// refused to send — even though sending worked perfectly.
const isReceiptWhatsAppConfigured = () => {
  const { isGupshupReceiptConfigured } = require("./gupshup.service");
  return RECEIPT_PROVIDER() === "gupshup" ? isGupshupReceiptConfigured() : isWhatsAppConfigured();
};

// Isolated on purpose: a WhatsApp failure (bad template name, Meta outage,
// invalid phone) must NEVER undo or break the donation record — the payment
// already succeeded and DCC (if configured) already has its own record.
// This mirrors the fix applied in subhojanam-server, where DCC, receipt
// generation, and WhatsApp send are each wrapped separately so one failing
// doesn't cascade into losing the others.
async function sendDonationWhatsAppReceipt(donation, options = {}) {
  // Rows reach this function from two places: the Mongo-compat models, which
  // decorate every row with `_id`, and (in tests and any future direct Prisma
  // code) the raw client, which only has `id`. Accept either rather than
  // silently reading undefined off one of them.
  const donationId = donation && (donation._id || donation.id);
  // Hard idempotency guard. Razorpay redelivers webhooks, reconciliation can
  // re-run over an already-completed donation, and the worker retries — any of
  // which reached this function a second time and sent the donor a SECOND
  // receipt for the same gift. whatsappReceiptSentAt is only set after a
  // confirmed send, so it is the right thing to gate on.
  //
  // The admin "Resend WhatsApp" button passes force: true, because there the
  // repeat is deliberate and a human asked for it.
  if (!options.force && donation.whatsappReceiptSentAt) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }
  const provider = RECEIPT_PROVIDER();
  const { isGupshupReceiptConfigured, sendReceiptWhatsappViaGupshup } = require("./gupshup.service");
  const configured = provider === "gupshup" ? isGupshupReceiptConfigured() : isWhatsAppConfigured();
  if (!configured) {
    return {
      ok: false,
      skipped: true,
      reason: provider === "gupshup" ? "gupshup_not_configured" : "whatsapp_not_configured",
    };
  }
  if (!donation.donorMobile) return { ok: false, skipped: true, reason: "no_phone_number" };

  // No receipt number yet (DCC hasn't synced, or failed) -- per policy, no
  // WhatsApp message goes out at all until there's a real receipt to send.
  // This used to fall back to a plain "thank you" text template, but that
  // meant donors could get a WhatsApp message implying their donation was
  // fully processed even when DCC had actually failed (e.g. the DCC-side
  // duplicate-donor / outage cases found while debugging real donations).
  // The admin "Resend WhatsApp" action re-checks this same condition, so
  // once DCC is manually resynced, sending the real receipt is one click.
  if (!donation.receiptNumber) {
    return { ok: false, skipped: true, reason: "no_receipt_yet" };
  }

  const amountText = `Rs. ${Number(donation.amount || 0).toLocaleString("en-IN")}`;
  let tmpFile = null;
  try {
    const pdfBytes = await generateReceiptBuffer(donationId);
    tmpFile = path.join(os.tmpdir(), `receipt-${donationId}-${Date.now()}.pdf`);
    fs.writeFileSync(tmpFile, pdfBytes);

    const filename = `Donation_Receipt_${String(donation.donorName || "Donor").replace(/\s+/g, "_")}.pdf`;
    // Gupshup's template API accepts only a public LINK for a document header,
    // so the PDF is uploaded to this site's R2 bucket and that URL is sent.
    // Flaxxa takes the same PDF as binary multipart from the temp file.
    const sendResult =
      provider === "gupshup"
        ? await sendReceiptWhatsappViaGupshup({
            phone: donation.donorMobile,
            donorName: donation.donorName || "Devotee",
            amountText: amountText.replace(/^Rs\.\s*/, ""),
            sevaName: donation.sevaName || donation.type || "Seva",
            pdfBytes,
            filename,
            donationId: String(donationId),
          })
        : await sendTemplateMessageWithAttachment(
            donation.donorMobile,
            RECEIPT_TEMPLATE_NAME,
            [
              { type: "text", text: donation.donorName || "Devotee" },
              { type: "text", text: amountText.replace(/^Rs\.\s*/, "") },
              { type: "text", text: donation.sevaName || donation.type || "Seva" },
            ],
            tmpFile,
            filename
          );

    await donationModel.findByIdAndUpdate(donationId, {
      whatsappReceiptSentAt: new Date(),
      whatsappReceiptError: null,
      // Joined back on by the Gupshup delivery callback.
      whatsappMessageId: (sendResult && sendResult.messageId) || undefined,
    });
    return { ok: true, withPdf: true, provider };
  } catch (error) {
    // PDF generation or the WhatsApp send itself failed -- still no
    // message goes out (per policy), just record why for admin visibility.
    const message = error && error.message ? error.message : String(error);
    console.error("WhatsApp PDF receipt failed for donation", String(donationId), message);
    await donationModel.findByIdAndUpdate(donationId, { whatsappReceiptError: message });
    return { ok: false, error: message };
  } finally {
    if (tmpFile) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
}

// Fast path: marks the donation as completed and sets payment IDs.
// Returns the donation document (or null if not found).
async function markDonationCompleted({ donationId, orderId, paymentId }) {
  const query = donationId
    ? { _id: donationId }
    : { razorpayOrderId: orderId };

  let donation = await donationModel.findOneAndUpdate(
    { ...query, status: { $ne: "completed" } },
    {
      status: "completed",
      ...(paymentId
        ? {
            razorpayPaymentId: paymentId,
            transactionId: paymentId,
          }
        : {}),
    },
    { new: true }
  );

  if (!donation) {
    donation = await donationModel.findOne(query);
  }

  if (!donation) return null;

  if (paymentId && (!donation.razorpayPaymentId || !donation.transactionId)) {
    donation = await donationModel.findByIdAndUpdate(
      donation._id,
      {
        razorpayPaymentId: paymentId,
        transactionId: paymentId,
      },
      { new: true }
    );
  }

  return donation;
}

// Background pipeline: DCC sync, WhatsApp receipt, Meta CAPI.
// Errors are recorded per-donation for admin visibility — never throws.
async function runPostCompletionPipeline(donationId, paymentId) {
  try {
    let donation = await donationModel.findById(donationId);
    if (!donation) return;

    await syncDonationToDcc(donation, paymentId);

    donation = await donationModel.findById(donationId);

    await sendDonationWhatsAppReceipt(donation);

    try {
      const { sendPurchaseEvent } = require("./metaCapi.service");
      await sendPurchaseEvent(donation);
    } catch (e) {
      console.warn("Meta CAPI purchase event failed (non-fatal):", e && e.message ? e.message : e);
    }
  } catch (err) {
    console.error("Post-completion pipeline error for donation", String(donationId), err && err.stack ? err.stack : err);
  }
}

// Full synchronous flow: mark completed + run pipeline.
// Used by webhooks and reconciliation where no user is waiting.
async function completeDonation({ donationId, orderId, paymentId }) {
  const donation = await markDonationCompleted({ donationId, orderId, paymentId });
  if (!donation) return null;

  await runPostCompletionPipeline(donation._id, paymentId);

  return donationModel.findById(donation._id);
}

module.exports = {
  completeDonation,
  markDonationCompleted,
  runPostCompletionPipeline,
  sendDonationWhatsAppReceipt,
  isReceiptWhatsAppConfigured,
};

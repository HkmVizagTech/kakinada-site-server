// src/services/pendingReminder.service.js
//
// Pending-transaction WhatsApp reminder — the same flow HKM Vizag runs,
// adapted to this site's donation model.
//
// Two kinds of donation get the nudge, both with the identical "pending"
// wording (donors don't need the distinction, and it keeps one approved
// template covering everything):
//   "pending" — the Razorpay order was created but never captured: an
//               abandoned checkout, or a payment still in progress.
//   "failed"  — Razorpay sent payment.failed for the order and no capture was
//               found (see payment.controller.js). The donor tried and the
//               payment did not go through, so the nudge is if anything more
//               useful here than for an abandoned checkout.
// Once such a donation is older than the cutoff (default 6 minutes, like
// Annadan) and we haven't already messaged the donor, we send the approved
// "pending transaction" WhatsApp template with that donation's own seva name.
//
// The whatsappPendingReminderSent flag makes this idempotent: it is set only
// after a successful send, so overlapping runs (in-process scheduler + an
// external cron hitting the internal endpoint) can never double-message.

const { donationModel } = require("../models/donation.model");
const {
  isWhatsAppConfigured,
  sendPendingWhatsapp,
} = require("./whatsapp.service");
const {
  isGupshupConfigured,
  sendPendingWhatsappViaGupshup,
} = require("./gupshup.service");

// Which BSP sends the pending reminder, chosen by PENDING_WHATSAPP_PROVIDER.
//
//   "gupshup" (default) — the number and approved templates shared with HKM
//              Vizag. Gupshup fills a template's dynamic URL button, so the
//              reminder keeps its "Transaction Link". Needs GUPSHUP_API_KEY,
//              GUPSHUP_APP_NAME and GUPSHUP_PENDING_TEMPLATE_ID.
//              NOTE: while the shared Vizag template is in use, that button
//              points at the Vizag domain — gupshup.service.js detects this
//              and writes the correct link into the body instead.
//   "flaxxa"           — the Flaxxa WAPI number. Flaxxa cannot fill a {{1}}
//              in a button link at all, so the seva link always rides in the
//              body. Needs WAPI_TOKEN and an approved
//              WAPI_PENDING_TEMPLATE_NAME on that number.
//
// Gupshup is the default because that is what is actually provisioned for this
// site today; flip the variable to roll back without a deploy.
const PROVIDER = String(process.env.PENDING_WHATSAPP_PROVIDER || "gupshup").toLowerCase();

function resolveProvider() {
  if (PROVIDER === "gupshup") {
    return {
      name: "gupshup",
      configured: isGupshupConfigured(),
      reason: "gupshup_not_configured",
      send: sendPendingWhatsappViaGupshup,
    };
  }
  return {
    name: "flaxxa",
    configured: isWhatsAppConfigured(),
    reason: "whatsapp_not_configured",
    send: sendPendingWhatsapp,
  };
}

// How old a pending donation must be before we nudge the donor (6 minutes —
// enough for UPI/auto-debit flows to settle or fail visibly, and for the
// donor to have genuinely abandoned an in-progress checkout).
const CUTOFF_MINUTES = Number(process.env.PENDING_REMINDER_CUTOFF_MINUTES || 6);

// ...and how old is TOO old. Without this floor, the very first run after
// deploy would sweep up every pending/failed donation ever recorded and
// message donors about attempts they abandoned months ago. It also keeps the
// job sane in steady state: a nudge about a checkout from last week is noise,
// not a reminder. Anything older than this is ignored permanently — it never
// becomes eligible again, so nothing accumulates waiting to be released.
const MAX_AGE_HOURS = Number(process.env.PENDING_REMINDER_MAX_AGE_HOURS || 24);

// Batch size per run — keeps each pass short and lets the schedule loop
// around to remaining records on later runs.
const BATCH_SIZE = Number(process.env.PENDING_REMINDER_BATCH_SIZE || 100);

// How many failed sends before a donation is left alone. The job marks a
// donation reminded only on a real success, so a permanently unsendable record
// would otherwise be retried every pass forever — and since the batch is
// ordered oldest-first with a fixed limit, a pile of them would crowd newer
// donations out of the batch. Their last error is kept on the record.
const MAX_ATTEMPTS = Number(process.env.PENDING_REMINDER_MAX_ATTEMPTS || 3);

// Donation statuses that earn a reminder. Both get the same message.
// Override with a comma-separated PENDING_REMINDER_STATUSES if needed.
const REMINDER_STATUSES = String(process.env.PENDING_REMINDER_STATUSES || "pending,failed")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A donor whose payment fails or stalls usually retries straight away, and
// each attempt creates its OWN donation record — so the failed record lingers
// while the retry succeeds. Telling someone "your transaction of Rs.2100 is
// pending" minutes after their money actually went through is worse than
// saying nothing: it reads as "your payment did not work", and some donors
// will pay a second time.
//
// So immediately before each send we re-check the database: has this mobile
// number completed a donation since it made this attempt? If yes, stay quiet.
//
// The lookback grace covers the case where the successful payment is recorded
// a little BEFORE the stalled record's own timestamp (clock skew, or a webhook
// landing out of order). It is deliberately small: a wide window would
// suppress legitimate reminders for regular donors, who by definition have
// completed donations in their history. Set to 0 to disable the check.
const RETRY_GRACE_MINUTES = Number(
  process.env.PENDING_REMINDER_SKIP_IF_COMPLETED_WITHIN_MINUTES || 15
);

// Mirrors SUCCESS_STATUSES in donationAdmin.controller.js.
const SUCCESS_STATUSES = ["completed"];

// donorMobile is stored as the donor typed it, so the same person can appear
// as "9951141915", "919951141915" or "+91 99511 41915" across attempts.
// Match on the common variants of the last 10 digits — exact values rather
// than a suffix regex, so the donorMobile index is still usable.
function mobileVariants(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (digits.length < 10) return digits ? [String(raw), digits] : [];
  const last10 = digits.slice(-10);
  return [last10, `91${last10}`, `+91${last10}`, `0${last10}`, String(raw)];
}

/**
 * True when this donor has already completed a donation since making this
 * attempt — i.e. the pending/failed record is a superseded retry and the
 * money is in.
 */
async function donorAlreadyCompleted(donation) {
  if (!RETRY_GRACE_MINUTES || !donation.donorMobile) return false;

  const variants = mobileVariants(donation.donorMobile);
  if (!variants.length) return false;

  const since = new Date(
    new Date(donation.createdAt).getTime() - RETRY_GRACE_MINUTES * 60 * 1000
  );

  const completed = await donationModel
    .findOne({
      _id: { $ne: donation._id },
      donorMobile: { $in: variants },
      status: { $in: SUCCESS_STATUSES },
      createdAt: { $gte: since },
    })
    .select("_id amount sevaName createdAt")
    .lean();

  return completed || false;
}

// Desktop banner image shown as the WhatsApp template header, keyed by the
// donation's base sourcePage (see baseSourcePage). If a page has no dedicated
// image here, the generic WAPI_PENDING_IMAGE default (or no header) is used.
// ── Seva banner, link and campaign resolution ──────────────────────────────
//
// HKM Vizag hardcodes a table of banner images and link suffixes per seva,
// because that site has ~20 landing pages with bespoke artwork. This site has
// far fewer pages, and its donations already record where they came from, so
// the donation's own `sourcePage` / `festivalSlug` drive the link and no
// per-seva table has to be kept in sync by hand.
//
// Anything genuinely site-specific is configured rather than coded:
//   PENDING_REMINDER_SEVA_IMAGES  JSON, { "<sourcePage>": "<banner url>" }
//   PENDING_REMINDER_DEFAULT_IMAGE  banner used when nothing else matches
//   PENDING_REMINDER_CAMPAIGN_LABELS  JSON, { "<festivalSlug>": "<label>" }

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    console.warn(`[pendingReminder] ${name} is not valid JSON, ignoring it:`, err.message);
    return {};
  }
}

const SEVA_IMAGES = parseJsonEnv("PENDING_REMINDER_SEVA_IMAGES");
const DEFAULT_SEVA_IMAGE = process.env.PENDING_REMINDER_DEFAULT_IMAGE || "";
const CAMPAIGN_LABELS = parseJsonEnv("PENDING_REMINDER_CAMPAIGN_LABELS");

// A P2P campaign link is "<page>/c/<campaigner>"; the banner belongs to the
// page, not to the individual campaigner.
function baseSourcePage(sourcePage) {
  return String(sourcePage || "").replace(/^\/+/, "").replace(/\/c\/[^/]+$/, "");
}

function getSevaImage(donation) {
  const page = baseSourcePage(donation && donation.sourcePage);
  return SEVA_IMAGES[page] || DEFAULT_SEVA_IMAGE || "";
}

// "sri-krishna-janmashtami" -> "Sri Krishna Janmashtami"
function prettifySlug(slug) {
  return String(slug || "")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The campaign a donation came from, shown in {{3}} so an abandoned festival
// checkout is recognisable. Configured labels win; otherwise the festival slug
// is prettified, which is right often enough to be worth doing automatically.
function resolveCampaignLabel(donation) {
  if (!donation) return "";
  const slug = donation.festivalSlug || "";
  if (!slug) return "";
  return CAMPAIGN_LABELS[slug] || prettifySlug(slug);
}

// Where to send the donor back to. The donation already knows: it recorded the
// page it was started from. Falling back to the festival slug covers older
// records written before sourcePage was populated everywhere.
function resolveLinkSuffix(donation) {
  const page = baseSourcePage(donation && donation.sourcePage);
  if (page) return page;
  if (donation && donation.festivalSlug) return String(donation.festivalSlug);
  return "donate";
}

// Deep-link the seva and amount so the page opens pre-filled. Only pages that
// actually read those params should be listed, otherwise the query is noise.
const DEEP_LINK_PAGES = new Set(
  String(process.env.PENDING_REMINDER_DEEP_LINK_PAGES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function resolveSevaSlug(donation) {
  const name = String((donation && donation.sevaName) || "").trim();
  if (!name) return "";
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolveLinkQuery(donation, linkSuffix) {
  if (!DEEP_LINK_PAGES.has(String(linkSuffix || ""))) return null;
  const seva = resolveSevaSlug(donation);
  const amount = Number(donation && donation.amount);
  const query = {};
  if (seva) query.seva = seva;
  // The donation pages enforce a minimum; pre-filling below it just shows an error.
  if (Number.isFinite(amount) && amount >= 100) query.amount = String(Math.round(amount));
  return Object.keys(query).length ? query : null;
}

async function runPendingReminders() {
  const provider = resolveProvider();
  if (!provider.configured) {
    return { skipped: true, reason: provider.reason, provider: provider.name, checked: 0, sent: 0, failed: 0 };
  }

  const now = Date.now();
  // Old enough to have genuinely stalled...
  const cutoff = new Date(now - CUTOFF_MINUTES * 60 * 1000);
  // ...but recent enough that the donor still remembers making the attempt.
  const floor = new Date(now - MAX_AGE_HOURS * 60 * 60 * 1000);

  const pendingDonations = await donationModel
    .find({
      status: { $in: REMINDER_STATUSES },
      createdAt: { $lte: cutoff, $gte: floor },
      whatsappPendingReminderSent: { $ne: true },
      // Give up on records that have already failed MAX_ATTEMPTS times.
      //
      // The Mongo original also had an `$exists: false` branch, to catch
      // documents written before the field was introduced. That branch is not
      // just unnecessary here but actively wrong: the Postgres column is
      // NOT NULL with a default of 0, so every row has a value, and asking
      // Prisma for `equals: null` on a non-nullable Int is rejected outright
      // with "Argument `equals` is missing" — which took the whole job down.
      whatsappPendingReminderAttempts: { $lt: MAX_ATTEMPTS },
      // Skip recurring/subscription first-charges — those stay "pending"
      // until the subscription activates, and the donor already authorised
      // autopay, so a "donation not confirmed" nudge would be wrong here.
      isRecurring: { $ne: true },
    })
    .sort({ createdAt: 1 })
    .limit(BATCH_SIZE);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const donation of pendingDonations) {
    if (!donation.donorMobile) {
      // No phone on record — nothing to message; mark it so we don't re-check
      // this record forever on every pass.
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      continue;
    }

    // Superseded retry — this donor's money already went through, so a
    // "still pending" message would only confuse them into paying twice.
    const completedInstead = await donorAlreadyCompleted(donation);
    if (completedInstead) {
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      skipped += 1;
      console.log(
        `Pending reminder skipped for ${donation.status} donation ${String(donation._id)} —`,
        `donor completed donation ${String(completedInstead._id)} instead`,
      );
      continue;
    }

    const linkSuffix = resolveLinkSuffix(donation);

    try {
      await provider.send(
        donation.donorMobile,
        donation.donorName || "Donor",
        donation.amount,
        donation.sevaName || donation.type || "your seva",
        {
          linkSuffix,
          linkQuery: resolveLinkQuery(donation, linkSuffix),
          sourcePage: donation.sourcePage,
          sevaImage: getSevaImage(donation),
          campaignLabel: resolveCampaignLabel(donation),
        },
      );
      donation.whatsappPendingReminderSent = true;
      await donation.save();
      sent += 1;
      console.log(
        `Pending reminder sent via ${provider.name} for ${donation.status} donation`,
        String(donation._id),
        "->",
        donation.donorMobile,
      );
    } catch (err) {
      failed += 1;
      const message = err && err.message ? err.message : String(err);
      donation.whatsappPendingReminderAttempts = (donation.whatsappPendingReminderAttempts || 0) + 1;
      donation.whatsappPendingReminderError = message.slice(0, 500);
      try {
        await donation.save();
      } catch (saveErr) {
        console.error("Could not record reminder failure for donation", String(donation._id), saveErr.message);
      }
      console.error(
        `Pending reminder failed via ${provider.name} for donation`,
        String(donation._id),
        err && err.response && err.response.data
          ? JSON.stringify(err.response.data)
          : (err && err.message ? err.message : err),
      );
    }
  }

  return {
    provider: provider.name,
    statuses: REMINDER_STATUSES,
    checked: pendingDonations.length,
    sent,
    failed,
    skipped,
    cutoffMinutes: CUTOFF_MINUTES,
    maxAgeHours: MAX_AGE_HOURS,
    window: { from: floor.toISOString(), to: cutoff.toISOString() },
  };
}

module.exports = {
  runPendingReminders,
  // Exported so the reminder's resolution logic can be unit-tested without a
  // database, and so a future banner-warming script can reuse it.
  SEVA_IMAGES,
  DEFAULT_SEVA_IMAGE,
  getSevaImage,
  resolveLinkSuffix,
  CAMPAIGN_LABELS,
  resolveCampaignLabel,
  DEEP_LINK_PAGES,
  resolveSevaSlug,
  resolveLinkQuery,
};

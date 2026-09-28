const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression");
const helmet = require("helmet");
const { prisma } = require("./src/lib/prisma");


const { userRouter } = require("./src/routes/user.routes");
const { eventRouter } = require("./src/routes/event.routes");
const { galleryRouter } = require("./src/routes/gallery.routes");
const { donationRouter } = require("./src/routes/donation.routes");
const { donationPageRouter } = require("./src/routes/donationPage.routes");
const { donationAdminRouter } = require("./src/routes/donationAdmin.routes");
const { festivalDonationRouter } = require("./src/routes/festivalDonation.routes");
const { paymentRouter } = require("./src/routes/payment.routes");
const { importantDateRouter } = require("./src/routes/importantDate.routes.js");
const { blogRouter } = require("./src/routes/blog.routes");
const { contactMessageRouter } = require("./src/routes/contactMessage.routes");
const { dashboardRouter } = require("./src/routes/dashboard.routes");
const { devoteeRouter } = require("./src/routes/devotee.routes");
const { siteContentRouter } = require("./src/routes/siteContent.routes");
const { heroBannerRouter } = require("./src/routes/heroBanner.routes");
const { mediaRouter } = require("./src/routes/media.routes");
const { volunteerRouter } = require("./src/routes/volunteer.routes");
const { blogProxyRouter } = require("./src/routes/blogProxy.routes");
const app = express();

// Railway terminates TLS at its edge proxy and forwards the real client address
// in X-Forwarded-For. Without this, req.ip is the proxy's own address, and
// express-rate-limit refuses to run at all (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR)
// -- which means the login brute-force limiter in user.routes.js was throwing on
// every request instead of protecting anything.
//
// `1` trusts exactly one hop, the Railway proxy. `true` would trust the whole
// chain, letting any client spoof X-Forwarded-For and get a fresh rate-limit
// bucket per forged IP -- i.e. no brute-force protection at all.
app.set("trust proxy", 1);

// Origins allowed to call this API.
//
// FRONTEND_URL is the real switch — set it to the public client URL on Railway
// and production origins are picked up from it. `*.vercel.app` is matched
// separately below so Vercel preview deploys keep working without a redeploy
// per branch.
//
// The apex + www pair is listed explicitly: browsers send the exact origin in
// the header, so allowing only one of the two will CORS-block the other.
const allowedOrigins = new Set([
  process.env.FRONTEND_URL,
  'https://iskconkakinada.org',
  'https://www.iskconkakinada.org',
  'http://localhost:3000',
  'http://localhost:8080',
].filter(Boolean));

app.use(
  cors({
    origin: (origin, callback) => {

      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);

      try {
        const hostname = new URL(origin).hostname;
        if (hostname.endsWith('.vercel.app')) return callback(null, true);
        if (hostname === 'iskconkakinada.org' || hostname.endsWith('.iskconkakinada.org')) return callback(null, true);
      } catch (e) {

      }

      // Reject with 403 (not an thrown error → 500) so blocked origins get a
      // clear, deliberate status, and log the origin so allowlist gaps show
      // up immediately in the Railway logs instead of mysterious failures.
      console.warn(`[CORS] Blocked origin: ${origin}`);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With'],
    exposedHeaders: ['Set-Cookie', 'Authorization'],
    credentials: true,
    optionsSuccessStatus: 204,
  })
);


// gzip/brotli-compress responses (blog HTML, donor lists, etc.) — cheap
// bandwidth/latency win, applied before routes so it covers everything.
// Baseline security headers. crossOriginResourcePolicy is relaxed since
// this API serves JSON/images to a different origin (the Vercel frontend) —
// the strict default would block legitimate cross-origin fetches.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression());

app.use(cookieParser());

// Razorpay webhooks MUST receive the raw request body so the route-level
// express.raw() can hand the controller an untouched Buffer for HMAC
// signature verification. If the global express.json() below runs first,
// it consumes the stream and sets req.body to a parsed OBJECT — the
// controller then hashes "[object Object]" instead of the real payload and
// EVERY webhook fails signature validation (400 Invalid signature). That is
// exactly what got the live webhook disabled by Razorpay. Skipping these
// paths here lets the per-route express.raw() in payment.routes.js win.
const WEBHOOK_PATHS = new Set([
  "/payments/webhook",
  "/payments/webhook/donations",
  "/payments/webhook/touchstone",
]);
const globalJson = express.json({ limit: '10mb' }); // increased for rich CKEditor HTML payloads
app.use((req, res, next) => {
  if (WEBHOOK_PATHS.has(req.path)) return next();
  return globalJson(req, res, next);
});

app.use("/payments", paymentRouter);
app.use("/users", userRouter);
app.use("/events", eventRouter);
app.use("/gallery", galleryRouter);
app.use("/donations", donationRouter);
app.use("/donation-page", donationPageRouter);
app.use("/donations-admin", donationAdminRouter);
app.use("/blogs", blogRouter);
app.use("/contact-messages", contactMessageRouter);
app.use("/dashboard", dashboardRouter);
app.use("/devotees", devoteeRouter);
app.use("/site-content", siteContentRouter);
app.use("/hero-banners", heroBannerRouter);
app.use("/temple-devotees", require("./src/routes/templeDevotee.routes").templeDevoteeRouter);
app.use("/media", mediaRouter);

app.use("/important-dates", importantDateRouter);
app.use("/festival-donations", festivalDonationRouter);
app.use("/volunteers", volunteerRouter);
app.use("/blogs-proxy", blogProxyRouter);

// Gupshup's delivery callback. Mounted with its own body parser inside the
// router because Gupshup posts JSON on some events and form-encoded on others.
// The shared secret is in the PATH, not a header: self-serve Gupshup callbacks
// carry no signature and no custom headers.
app.use("/webhooks/whatsapp", require("./src/routes/whatsappWebhook.routes").whatsappWebhookRouter);

// Lets an external cron drive the pending-reminder job instead of (or as well
// as) the in-process scheduler in index.js. Guarded by a shared secret because
// it triggers outbound messages.
app.get("/api/internal/send-pending-reminders", async (req, res) => {
  const secret = process.env.INTERNAL_SECRET;
  if (!secret || req.headers["x-internal-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { runPendingReminders } = require("./src/services/pendingReminder.service");
    const result = await runPendingReminders();
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error("send-pending-reminders failed:", err);
    return res.status(500).json({ error: err && err.message ? err.message : "failed" });
  }
});

// dev routes removed for production safety


app.get('/health', async (req, res) => {
  // Mongoose exposed a numeric connection.readyState; Prisma has no equivalent,
  // so actually round-trip the database. A 200 here means Postgres answered.
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ server: 'ok', db: { state: 'connected' } });
  } catch (err) {
    res.status(503).json({ server: 'ok', db: { state: 'disconnected' } });
  }
});

module.exports = { app };

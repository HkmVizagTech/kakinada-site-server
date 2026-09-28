
require("dotenv").config();
const { app } = require("./app");
const { connectDb, disconnectDb, prisma } = require("./src/config/db");
const bcrypt = require("bcryptjs");
const PORT = process.env.PORT || 8080;

// ── Auto-seed admin on startup ────────────────────────────────────
// Ensures the first admin account always exists after every deployment.
// Safe to run repeatedly — skips if the email already exists.
//
// No default credentials: seeding requires ADMIN_EMAIL and ADMIN_PASSWORD
// to be explicitly configured. A hardcoded fallback would ship a publicly
// guessable admin password to every environment that forgets to set the
// variable.
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || "ISKCON Kakinada Admin";

  if (!email || !password) {
    console.log("[seed] ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping admin seed.");
    return;
  }

  // Previously this declared an inline Mongoose schema so the seed did not
  // depend on the full model tree loading. Prisma needs no equivalent: User is
  // declared in prisma/schema.prisma and the client is generated from it.
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Keep ADMIN_PASSWORD authoritative: if the stored hash no longer matches
    // the env var (e.g. the password was rotated in Railway after the first
    // seed), reset it on boot. Without this, changing ADMIN_PASSWORD in the
    // hosting dashboard silently does nothing — the old hash keeps winning.
    if (process.env.ADMIN_PASSWORD) {
      const matches = await bcrypt.compare(process.env.ADMIN_PASSWORD, existing.password || "");
      if (!matches) {
        await prisma.user.update({
          where: { id: existing.id },
          data: { password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 10) },
        });
        console.log(`[seed] Password for "${email}" reset to match ADMIN_PASSWORD ✓`);
      }
    }
    // The seed account must always be a full admin, even if the role was
    // changed later (e.g. accidentally demoted from a user-management UI).
    if (existing.role !== "admin") {
      await prisma.user.update({ where: { id: existing.id }, data: { role: "admin" } });
      console.log(`[seed] Role for "${email}" restored to admin ✓`);
    }
    console.log(`[seed] Admin "${email}" already exists (role: ${existing.role}). ✓`);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await prisma.user.create({ data: { name, email, password: hash, role: "admin" } });
  console.log(`[seed] Admin created: ${email} / role: admin ✓`);
}

// ── Graceful shutdown ─────────────────────────────────────────────
// Railway sends SIGTERM before replacing a container, then SIGKILLs whatever
// is still alive a few seconds later. If the process dies with the Prisma pool
// still open, Postgres logs one
//   SSL error: unexpected eof while reading
//   could not receive data from client: Connection reset by peer
// per pooled connection -- and in-flight requests are dropped on the floor.
// A clean prisma.$disconnect() produces none of that, so those log lines are a
// reliable signal that shutdown did not finish.
//
// The shape below is deliberate. An earlier version just called
// server.close(cb) and did the disconnect in the callback, with a 10s timeout
// that called process.exit(1). That is not enough on a real platform:
//   * server.close() waits for every open connection, and Railway's proxy
//     holds keep-alive sockets to the app, so the callback can be slow to fire.
//   * the timeout path exited WITHOUT disconnecting, which is precisely the
//     abrupt pool drop it was supposed to prevent.
//   * 10s can be longer than the platform's grace period, so SIGKILL wins.
// So: stop accepting, hang up idle keep-alives immediately, give real in-flight
// requests a short grace, force the stragglers, and disconnect on EVERY path.
const DRAIN_GRACE_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 3000);

function installShutdownHandlers(server) {
  let shuttingDown = false;

  const closeDatabaseAndExit = async (code) => {
    try {
      await disconnectDb();
      console.log("[shutdown] database disconnected cleanly");
    } catch (err) {
      console.error("[shutdown] error disconnecting database:", err && err.message);
    }
    process.exit(code);
  };

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received - draining`);

    // 1. Stop accepting new connections. The callback is a bonus, not the plan.
    let drained = false;
    server.close(() => {
      drained = true;
    });

    // 2. Hang up keep-alive sockets that are sitting idle between requests.
    //    Without this they hold the server open for their full timeout.
    //    (Node >= 18.2; guarded so an older runtime still shuts down.)
    if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();

    // 3. Give genuinely in-flight requests a short window to finish.
    const deadline = Date.now() + DRAIN_GRACE_MS;
    while (!drained && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (typeof server.closeIdleConnections === "function") server.closeIdleConnections();
    }

    // 4. Whatever is left has had its chance; cut it loose so the pool can
    //    close rather than being killed along with the process.
    if (!drained && typeof server.closeAllConnections === "function") {
      console.log("[shutdown] forcing remaining connections closed");
      server.closeAllConnections();
    }

    await closeDatabaseAndExit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

const startServer = async () => {
  try {
    await connectDb();
    await seedAdmin();

    const server = app.listen(PORT, () => {
      console.log(`server connected on port ${PORT}`);
    });

    installShutdownHandlers(server);

    // ── Pending-transaction reminder loop ──────────────────────────────
    // A plain interval rather than a cron library: the job is idempotent
    // (whatsappPendingReminderSent is set only after a confirmed send), so a
    // missed or doubled tick is harmless. Set PENDING_REMINDER_ENABLED=false
    // to turn it off without a deploy — do that if you run it from an
    // external cron against /api/internal/send-pending-reminders instead.
    if (process.env.PENDING_REMINDER_ENABLED !== "false") {
      const { runPendingReminders } = require("./src/services/pendingReminder.service");
      const intervalMinutes = Number(process.env.PENDING_REMINDER_INTERVAL_MINUTES || 10);
      const run = () =>
        runPendingReminders()
          .then((r) => {
            // Only worth a line when it actually did something.
            if (r && (r.sent || r.failed || r.skipped)) {
              console.log("[pendingReminder]", JSON.stringify(r));
            }
          })
          .catch((err) =>
            console.error("[pendingReminder] run failed:", err && err.message ? err.message : err)
          );

      // Not immediately: let the container finish booting and pass its
      // healthcheck before doing any outbound work.
      setTimeout(run, 30 * 1000);
      setInterval(run, Math.max(1, intervalMinutes) * 60 * 1000);
      console.log(`[pendingReminder] scheduler on, every ${intervalMinutes}m`);
    } else {
      console.log("[pendingReminder] scheduler disabled (PENDING_REMINDER_ENABLED=false)");
    }
  } catch (error) {
    console.log("server failed to start", error);
    process.exit(1);
  }
};

startServer();

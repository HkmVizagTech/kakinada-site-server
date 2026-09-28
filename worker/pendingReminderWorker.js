#!/usr/bin/env node
// Standalone one-shot runner for the pending-transaction reminder.
//
// index.js already runs this on an interval inside the web process, and
// app.js exposes it at /api/internal/send-pending-reminders for an external
// cron. This script is the third way in: a manual run, or a Railway cron
// service that should not depend on the web process being awake.
//
// All three are safe to overlap — whatsappPendingReminderSent is only set
// after a provider confirms the send, so a donor cannot be messaged twice.
require("dotenv").config();

const { connectDb, disconnectDb } = require("../src/config/db");
const { runPendingReminders } = require("../src/services/pendingReminder.service");

(async () => {
  try {
    await connectDb();
    const result = await runPendingReminders();
    console.log("[pendingReminderWorker]", JSON.stringify(result));
    await disconnectDb();
    process.exit(0);
  } catch (err) {
    console.error("[pendingReminderWorker] failed:", err && err.stack ? err.stack : err);
    try { await disconnectDb(); } catch {}
    process.exit(1);
  }
})();

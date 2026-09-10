
require("dotenv").config();
const { app } = require("./app");
const { connectDb } = require("./src/config/db");
const mongoose = require("mongoose");
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

  // Inline schema so we don't depend on the full model tree loading
  const userSchema = new mongoose.Schema(
    { name: String, email: { type: String, unique: true }, password: String,
      role: { type: String, enum: ["user", "donations_admin", "blogs_admin", "admin"], default: "user" } },
    { timestamps: true }
  );
  const User = mongoose.models.User || mongoose.model("User", userSchema);

  const existing = await User.findOne({ email });
  if (existing) {
    // Keep ADMIN_PASSWORD authoritative: if the stored hash no longer matches
    // the env var (e.g. the password was rotated in Railway after the first
    // seed), reset it on boot. Without this, changing ADMIN_PASSWORD in the
    // hosting dashboard silently does nothing — the old hash keeps winning.
    if (process.env.ADMIN_PASSWORD) {
      const matches = await bcrypt.compare(process.env.ADMIN_PASSWORD, existing.password || "");
      if (!matches) {
        existing.password = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        await existing.save();
        console.log(`[seed] Password for "${email}" reset to match ADMIN_PASSWORD ✓`);
      }
    }
    // The seed account must always be a full admin, even if the role was
    // changed later (e.g. accidentally demoted from a user-management UI).
    if (existing.role !== "admin") {
      existing.role = "admin";
      await existing.save();
      console.log(`[seed] Role for "${email}" restored to admin ✓`);
    }
    console.log(`[seed] Admin "${email}" already exists (role: ${existing.role}). ✓`);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await User.create({ name, email, password: hash, role: "admin" });
  console.log(`[seed] Admin created: ${email} / role: admin ✓`);
}

const startServer = async () => {
  try {
    await connectDb();
    await seedAdmin();

    app.listen(PORT, () => {
      console.log(`server connected on port ${PORT}`);
    });
  } catch (error) {
    console.log("server failed to start", error);
    process.exit(1);
  }
};

startServer();

#!/usr/bin/env node
// One-off script: create the first admin user for ISKCON Kakinada.
// Run once: node scripts/seed-admin.js
// Safe to re-run — skips if the email already exists.
//
// Does NOT require npm install — parses .env manually and uses the
// same mongoose already in node_modules when run from the server dir
// after `npm install`. If node_modules is empty, run `npm install` first.

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

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is not set in .env");
  process.exit(1);
}

// ── Inline User schema ────────────────────────────────────────────
const userSchema = new mongoose.Schema(
  {
    name: String,
    email: { type: String, unique: true },
    password: String,
    role: {
      type: String,
      enum: ["user", "donations_admin", "blogs_admin", "admin"],
      default: "user",
    },
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

const EMAIL = "admin@iskconkakinada.org";
const PASSWORD = "Iskonkkd@108";
const NAME = "ISKCON Kakinada Admin";

async function main() {
  console.log("Connecting to MongoDB…");
  await mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  console.log("Connected ✓");

  const existing = await User.findOne({ email: EMAIL });
  if (existing) {
    console.log(`⚠️  Admin "${EMAIL}" already exists (role: ${existing.role}). Skipping.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const hash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create({ name: NAME, email: EMAIL, password: hash, role: "admin" });

  console.log(`✅ Admin created!`);
  console.log(`   Email:    ${EMAIL}`);
  console.log(`   Password: ${PASSWORD}`);
  console.log(`   Role:     ${user.role}`);
  console.log(`   ID:       ${user._id}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Failed:", err.message);
  process.exit(1);
});


require("dotenv").config();
const { app } = require("./app");
const { connectDb } = require("./src/config/db");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const PORT = process.env.PORT || 8080;

// ── Auto-seed admin on startup ────────────────────────────────────
// Ensures the first admin account always exists after every deployment.
// Safe to run repeatedly — skips if the email already exists.
async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL || "admin@iskconkakinada.org";
  const password = process.env.ADMIN_PASSWORD || "Iskonkkd@108";
  const name = process.env.ADMIN_NAME || "ISKCON Kakinada Admin";

  // Inline schema so we don't depend on the full model tree loading
  const userSchema = new mongoose.Schema(
    { name: String, email: { type: String, unique: true }, password: String,
      role: { type: String, enum: ["user", "donations_admin", "blogs_admin", "admin"], default: "user" } },
    { timestamps: true }
  );
  const User = mongoose.models.User || mongoose.model("User", userSchema);

  const existing = await User.findOne({ email });
  if (existing) {
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

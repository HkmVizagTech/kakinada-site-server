const { siteContentModel } = require("../models/siteContent.model");

// The Mongoose schema this replaced declared a default for every one of these
// fields, so a brand-new install rendered real copy. Prisma stores each block
// as a single `Json @default("{}")` column, which means those per-field
// defaults were lost in the port and the site came up with an empty hero and
// empty contact details. They live here now, and are merged under whatever the
// admin has actually saved.
const defaultSiteContent = {
  hero: {
    title: "Hare Krishna Movement",
    subtitle: "Kakinada",
    tagline:
      "Spreading the timeless message of Lord Krishna through devotion, service, and community",
  },
  about: { heading: "", body: "" },
  contact: {
    phone: "",
    email: "",
    address: "ISKCON Kakinada, Kakinada, Andhra Pradesh",
    morningHours: "4:30 AM - 1:00 PM",
    eveningHours: "4:00 PM - 8:30 PM",
  },
  navbar: {
    majorFestival: "none",
    customLink: { enabled: false, label: "", href: "" },
  },
};

// Postgres returns unset columns as explicit nulls rather than omitting them,
// so a plain spread would let a null wipe out the default beneath it.
const defined = (obj) =>
  Object.fromEntries(
    Object.entries(obj || {}).filter(([, v]) => v !== null && v !== undefined)
  );

const mergeWithDefaults = (content) => {
  const row = content || {};
  return {
    ...row,
    hero: { ...defaultSiteContent.hero, ...defined(row.hero) },
    about: { ...defaultSiteContent.about, ...defined(row.about) },
    contact: { ...defaultSiteContent.contact, ...defined(row.contact) },
    navbar: { ...defaultSiteContent.navbar, ...defined(row.navbar) },
  };
};

const siteContentController = {
  // PUBLIC - fetch site content (creates the default singleton on first read)
  get: async (req, res) => {
    try {
      let content = await siteContentModel.findOne({ key: "main" });
      if (!content) {
        content = await siteContentModel.create({ key: "main" });
      }
      res.status(200).json({ content: mergeWithDefaults(content) });
    } catch (err) {
      console.error("Site content get error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },

  // ADMIN - update any subset of hero/about/contact/navbar
  update: async (req, res) => {
    try {
      const { hero, about, contact, navbar } = req.body;
      const patch = { updatedBy: req.user?.userId };
      if (hero) patch.hero = hero;
      if (about) patch.about = about;
      if (contact) patch.contact = contact;
      if (navbar) patch.navbar = navbar;

      const content = await siteContentModel.findOneAndUpdate(
        { key: "main" },
        { $set: patch },
        { new: true, upsert: true }
      );
      res.status(200).json({ message: "Content updated", content: mergeWithDefaults(content) });
    } catch (err) {
      console.error("Site content update error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { siteContentController };

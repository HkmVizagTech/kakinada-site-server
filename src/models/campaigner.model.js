const mongoose = require("mongoose");

const campaignerSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["active", "inactive", "closed"],
      default: "active",
    },
    referredByDevotee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "templeDevotee",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
  },
  { timestamps: true, versionKey: false }
);

const campaignerModel = mongoose.model("campaigner", campaignerSchema);

module.exports = { campaignerModel };

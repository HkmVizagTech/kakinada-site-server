const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import heroBannerModel keep working unchanged.
const heroBannerModel = createModel("heroBanner");

module.exports = { heroBannerModel };

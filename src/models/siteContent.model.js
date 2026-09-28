const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import siteContentModel keep working unchanged.
const siteContentModel = createModel("siteContent");

module.exports = { siteContentModel };

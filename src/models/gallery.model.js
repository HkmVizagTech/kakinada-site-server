const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import galleryModel keep working unchanged.
const galleryModel = createModel("gallery");

module.exports = { galleryModel };

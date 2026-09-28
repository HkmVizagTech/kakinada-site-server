const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import mediaModel keep working unchanged.
const mediaModel = createModel("media");

module.exports = { mediaModel };

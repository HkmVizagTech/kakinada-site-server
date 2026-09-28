const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import donationModel keep working unchanged.
const donationModel = createModel("donation");

module.exports = { donationModel };

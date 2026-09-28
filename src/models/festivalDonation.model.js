const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import festivalDonationModel keep working unchanged.
const festivalDonationModel = createModel("festivalDonation");

module.exports = { festivalDonationModel };

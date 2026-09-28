const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import donationPageModel keep working unchanged.
const donationPageModel = createModel("donationPage");

module.exports = { donationPageModel };

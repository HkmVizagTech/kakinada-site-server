const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import userModel keep working unchanged.
const userModel = createModel("user");

module.exports = { userModel };

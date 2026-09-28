const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import registrationModel keep working unchanged.
const registrationModel = createModel("registration");

module.exports = { registrationModel };

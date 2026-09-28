const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import planModel keep working unchanged.
const planModel = createModel("plan");

module.exports = { planModel };

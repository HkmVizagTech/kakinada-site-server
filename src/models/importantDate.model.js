const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import importantDateModel keep working unchanged.
const importantDateModel = createModel("importantDate");

module.exports = { importantDateModel };

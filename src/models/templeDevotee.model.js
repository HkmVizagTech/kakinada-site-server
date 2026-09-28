const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import templeDevoteeModel keep working unchanged.
const templeDevoteeModel = createModel("templeDevotee");

module.exports = { templeDevoteeModel };

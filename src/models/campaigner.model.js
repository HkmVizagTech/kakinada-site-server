const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import campaignerModel keep working unchanged.
const campaignerModel = createModel("campaigner");

module.exports = { campaignerModel };

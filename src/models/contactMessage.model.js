const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import contactMessageModel keep working unchanged.
const contactMessageModel = createModel("contactMessage");

module.exports = { contactMessageModel };

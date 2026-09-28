const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import eventModel keep working unchanged.
const eventModel = createModel("event");

module.exports = { eventModel };

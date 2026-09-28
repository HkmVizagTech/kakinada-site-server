const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import volunteerEventModel keep working unchanged.
const volunteerEventModel = createModel("volunteerEvent");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import volunteerRegistrationModel keep working unchanged.
const volunteerRegistrationModel = createModel("volunteerRegistration");

module.exports = { volunteerEventModel, volunteerRegistrationModel };

// RETIRED — kept as a stub so nothing that still imports this path crashes.
//
// Image uploads moved to Cloudflare R2 (src/utils/r2.js, a drop-in replacement
// with the same call signature). Nothing in this server imported this module
// any more, but the `cloudinary` package it required was still installed and
// dragged in a vulnerable lodash. Removing the dependency meant this file had
// to stop requiring it — hence the stub rather than a deletion, so any
// straggler import fails loudly and usefully instead of with MODULE_NOT_FOUND.
const RETIRED =
  "utils/cloudinary.js is retired — use uploadToR2() from utils/r2.js instead.";

const uploadToCloudinary = async () => {
  throw new Error(RETIRED);
};

module.exports = {
  get cloudinary() {
    throw new Error(RETIRED);
  },
  uploadToCloudinary,
};

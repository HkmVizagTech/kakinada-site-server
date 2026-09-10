// src/config/R2.config.js
// Cloudflare R2 client — same account/bucket pattern already used in
// campaign-server (HkmVizagTech's campaigner platform). CommonJS here
// since hkmsite2.0-server is not an ESM package (campaign-server is).
const { S3Client } = require("@aws-sdk/client-s3");

const accountId = process.env.R2_ACCOUNT_ID || "";
if (!accountId) {
  console.error(
    "[R2] WARNING: R2_ACCOUNT_ID is not set — uploads will fail with a confusing " +
    "SSL handshake error. Set it in Railway → Variables."
  );
} else {
  const ak = process.env.R2_ACCESS_KEY_ID || "";
  const sk = process.env.R2_SECRET_ACCESS_KEY || "";
  console.log(
    `[R2] Config loaded — accountId: ${accountId.slice(0, 6)}…, ` +
    `accessKey: ${ak ? ak.slice(0, 6) + "…" : "MISSING"}, ` +
    `secretKey: ${sk ? sk.slice(0, 6) + "…" : "MISSING"}, ` +
    `bucket: ${process.env.R2_BUCKET_NAME || "MISSING"}`
  );
}
const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

const r2Client = new S3Client({
  region: "auto",
  endpoint,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const bucketName = process.env.R2_BUCKET_NAME;

module.exports = { r2Client, bucketName };

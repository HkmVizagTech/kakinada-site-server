// Prisma connection helper.
//
// The Prisma client in src/lib/prisma.js is lazy -- it does not open a socket
// until the first query. This module exists so index.js keeps the same
// `await connectDb()` startup shape it had with Mongoose, and so a failure to
// reach Postgres is a clear startup error rather than a crash on first request.
const { prisma } = require("../lib/prisma");

async function connectDb() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. On Railway this is injected automatically by " +
        "the Postgres plugin; locally, copy .env.example to .env and fill it in."
    );
  }

  try {
    // A trivial round-trip so a bad host, bad password or a missing migration
    // fails here at boot instead of on whichever request happens to hit first.
    await prisma.$queryRaw`SELECT 1`;
    console.log("PostgreSQL connected");
  } catch (error) {
    console.error("PostgreSQL connection error:", error.message);
    throw error;
  }
}

async function disconnectDb() {
  await prisma.$disconnect();
}

module.exports = { connectDb, disconnectDb, prisma };

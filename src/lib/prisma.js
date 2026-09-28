// Prisma client singleton.
//
// Mongoose kept one global connection for the process; Prisma wants an
// explicit client. This module is the single place one is created, and it
// survives `nodemon` reloads by stashing the instance on globalThis
// (otherwise every file watch leaks a connection pool until Postgres refuses
// new clients).
const { PrismaClient } = require("@prisma/client");

// A missing DATABASE_URL otherwise surfaces as a bare Prisma P1012 during
// `prisma migrate deploy`, repeated once per crash-loop restart, with no hint
// about where the value is supposed to come from. Say so once, plainly.
if (!process.env.DATABASE_URL) {
  console.error(
    [
      "",
      "FATAL: DATABASE_URL is not set.",
      "",
      "This app will not start without it. On Railway it is normally injected",
      "by the PostgreSQL plugin, so either:",
      "  a) the Postgres service is not linked to this service -- add it under",
      "     this service's Settings -> Service Dependencies, or",
      "  b) the Postgres service lives in a different project/environment, or",
      "  c) the DATABASE_URL variable was deleted and not replaced.",
      "",
      "Fallback: open the Postgres service, copy its DATABASE_URL value, and",
      "paste it here as a variable. It looks like:",
      "  postgresql://postgres:****@****.railway.app:5432/railway",
      "",
    ].join("\n")
  );
}

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__rjyPrisma ||
  new PrismaClient({
    log:
      process.env.PRISMA_LOG === "true"
        ? ["query", "warn", "error"]
        : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__rjyPrisma = prisma;
}

module.exports = { prisma, PrismaClient };

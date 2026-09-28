const { prisma } = require("../lib/prisma");

// Was a Mongo aggregation that grouped completed donations into devotees.
// The two CTEs mirror the original $group and the $addFields/$switch tiering;
// the tier expression is repeated in the outer WHERE because Postgres cannot
// reference a SELECT alias in the same query's WHERE.
const TIER_PATRON = 100000;
const NEW_CUTOFF_DAYS = 30;

const tierExpr = (cutoffParam) => `
  CASE
    WHEN "totalAmount" >= ${TIER_PATRON} THEN 'patron'
    WHEN "firstDonation" >= $${cutoffParam} THEN 'new'
    ELSE 'active'
  END`;

const devoteeController = {
  // ADMIN - real devotee list, aggregated from completed donations
  // (there is no separate "devotee" collection; a devotee IS a donor)
  list: async (req, res) => {
    try {
      const { q, status, page = 1, limit = 50 } = req.query;

      const where = [];
      const params = [];
      const push = (v) => {
        params.push(v);
        return `$${params.length}`;
      };

      // Pushed first so it is always $1: the tier expression is referenced
      // twice (once in the CTE, once in the outer status filter) and both
      // occurrences must bind the same cutoff date.
      push(new Date(Date.now() - NEW_CUTOFF_DAYS * 24 * 60 * 60 * 1000));

      if (q) {
        // Escaped for LIKE, and applied to the aggregated values exactly as the
        // original post-$group $match did.
        const term = `%${String(q).replace(/([\\%_])/g, "\\$1")}%`;
        where.push(
          `("name" ILIKE ${push(term)} OR "email" ILIKE ${push(term)} OR "phone" ILIKE ${push(term)})`
        );
      }
      if (status && status !== "all") {
        where.push(`${tierExpr(1)} = ${push(status)}`);
      }

      const sql = `
        WITH grouped AS (
          SELECT
            COALESCE("donorEmail", "donorMobile") AS "_id",
            MAX("donorName")                      AS "name",
            MAX("donorEmail")                     AS "email",
            MAX("donorMobile")                    AS "phone",
            MAX("prasadamAddress"->>'city')       AS "city",
            COUNT(*)::int                         AS "donations",
            COALESCE(SUM("amount"), 0)            AS "totalAmount",
            MIN("date")                           AS "firstDonation",
            MAX("date")                           AS "lastDonation"
          FROM "donations"
          WHERE "status" = 'completed'
          GROUP BY COALESCE("donorEmail", "donorMobile")
        ),
        tiered AS (
          SELECT grouped.*, ${tierExpr(1)} AS "status"
          FROM grouped
        )
        SELECT * FROM tiered
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY "totalAmount" DESC
      `;

      const allResults = await prisma.$queryRawUnsafe(sql, ...params);
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const start = (pageNum - 1) * lim;
      const devotees = allResults.slice(start, start + lim);

      res.status(200).json({
        devotees,
        total: allResults.length,
        page: pageNum,
        totalPages: Math.ceil(allResults.length / lim),
      });
    } catch (err) {
      console.error("Devotees list error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { devoteeController };

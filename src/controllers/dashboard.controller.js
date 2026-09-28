const { donationModel } = require("../models/donation.model");
const { eventModel } = require("../models/event.model");
const { galleryModel } = require("../models/gallery.model");
const { blogModel } = require("../models/blog.model");
const { contactMessageModel } = require("../models/contactMessage.model");

// The standalone /donations page is a fully separate donation flow with its
// own dedicated admin (/donations/admin) -- it must never be blended into
// these site-wide totals/charts. sourcePage === "donations" (exact, no
// leading slash) is the reliable signal for it; every other donation flow
// (seva pages, sqft campaign, janmashtami) uses a real path or a distinct
// value, confirmed by sampling real records.
const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $ne: "donations" } };

const timeAgo = (date) => {
  const diffMs = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? "s" : ""} ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
};

const { prisma } = require("../lib/prisma");
const { buildWhere } = require("../lib/sqlFilter");

// ── Reporting queries ───────────────────────────────────────────────────────
// These were Mongo aggregation pipelines and are now plain SQL through
// $queryRaw. Two things to keep in mind when reading the SQL:
//   * SUM/COUNT/group-by return a single row, not an array, so the `.then(r =>
//     r[0])` on the scalar queries replaces the old `agg[0]?.total`.
//   * Where a $group keyed on a composite _id, jsonb_build_object reproduces
//     that nested shape so the response (and the client) is unchanged.

/** COUNT(DISTINCT ...) over the email-or-mobile identity used elsewhere. */
const distinctDonorCount = (whereSql, params) =>
  prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT COALESCE("donorEmail", "donorMobile"))::int AS "distinctDonors"
       FROM "donations" ${whereSql}`,
    ...params
  );

const dashboardController = {
  // ADMIN - real dashboard summary stats (replaces hardcoded numbers)
  stats: async (req, res) => {
    try {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const startOfLastMonth = new Date(startOfMonth);
      startOfLastMonth.setMonth(startOfLastMonth.getMonth() - 1);

      const completedWhere = buildWhere({ status: "completed", ...EXCLUDE_DONATIONS_PAGE });
      const lastMonthWhere = buildWhere({
        status: "completed",
        date: { $gte: startOfLastMonth, $lt: startOfMonth },
        ...EXCLUDE_DONATIONS_PAGE,
      });

      const [
        donationRow,
        lastMonthRow,
        eventsThisMonth,
        galleryCount,
        galleryLastMonthCount,
        blogCount,
        distinctDonorsRow,
        newMessagesCount,
      ] = await Promise.all([
        prisma
          .$queryRawUnsafe(
            `SELECT COALESCE(SUM("amount"), 0) AS "total", COUNT(*)::int AS "count"
               FROM "donations" ${completedWhere.sql}`,
            ...completedWhere.params
          )
          .then((r) => r[0]),
        prisma
          .$queryRawUnsafe(
            `SELECT COALESCE(SUM("amount"), 0) AS "total"
               FROM "donations" ${lastMonthWhere.sql}`,
            ...lastMonthWhere.params
          )
          .then((r) => r[0]),
        eventModel.countDocuments({ date: { $gte: startOfMonth } }),
        galleryModel.countDocuments({}),
        galleryModel.countDocuments({ createdAt: { $lt: startOfMonth } }),
        blogModel.countDocuments({ status: "published" }),
        distinctDonorCount(completedWhere.sql, completedWhere.params),
        contactMessageModel.countDocuments({ status: "new" }),
      ]);

      const totalDonations = donationRow?.total ?? 0;
      const lastMonthDonations = lastMonthRow?.total ?? 0;
      const donationChangePct = lastMonthDonations > 0
        ? Math.round(((totalDonations - lastMonthDonations) / lastMonthDonations) * 100)
        : null;

      const galleryNewThisMonth = galleryCount - galleryLastMonthCount;
      const distinctDonors = distinctDonorsRow?.[0]?.distinctDonors ?? 0;

      // Monthly trend for the last 6 months — real aggregation, not fabricated
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
      sixMonthsAgo.setDate(1);
      sixMonthsAgo.setHours(0, 0, 0, 0);

      const monthlyWhere = buildWhere({
        status: "completed",
        date: { $gte: sixMonthsAgo },
        ...EXCLUDE_DONATIONS_PAGE,
      });
      const monthlyDonations = await prisma.$queryRawUnsafe(
        // jsonb, not json: Postgres cannot group or order by `json` (42883,
        // "could not identify an ordering operator for type json"). Grouping
        // and ordering are also spelled out over the real EXTRACT expressions
        // rather than positionally, so the months come back in chronological
        // order by construction instead of by luck of jsonb key ordering.
        `SELECT
           jsonb_build_object(
             'year',  EXTRACT(YEAR  FROM "date")::int,
             'month', EXTRACT(MONTH FROM "date")::int
           ) AS "_id",
           COALESCE(SUM("amount"), 0) AS "donations",
           COUNT(*)::int AS "count"
         FROM "donations" ${monthlyWhere.sql}
         GROUP BY EXTRACT(YEAR FROM "date"), EXTRACT(MONTH FROM "date")
         ORDER BY EXTRACT(YEAR FROM "date"), EXTRACT(MONTH FROM "date")`,
        ...monthlyWhere.params
      );

      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthlyData = monthlyDonations.map((m) => ({
        month: monthNames[m._id.month - 1],
        donations: m.donations,
        count: m.count,
      }));

      // Real seva-type breakdown (was a hardcoded pie chart before)
      const sevaAgg = await prisma.$queryRawUnsafe(
        `SELECT COALESCE("sevaName", "type") AS "_id", COUNT(*)::int AS "value"
           FROM "donations" ${completedWhere.sql}
           GROUP BY 1
           ORDER BY "value" DESC
           LIMIT 6`,
        ...completedWhere.params
      );
      const sevaBreakdown = sevaAgg.map((s) => ({ name: s._id || "Other", value: s.value }));

      // Status breakdown (completed / pending / failed) - real data for Analytics page
      const allWhere = buildWhere(EXCLUDE_DONATIONS_PAGE);
      const statusAgg = await prisma.$queryRawUnsafe(
        `SELECT "status" AS "_id", COUNT(*)::int AS "count", COALESCE(SUM("amount"), 0) AS "amount"
           FROM "donations" ${allWhere.sql}
           GROUP BY 1`,
        ...allWhere.params
      );
      const statusBreakdown = statusAgg.map((s) => ({ status: s._id, count: s.count, amount: s.amount }));

      // Daily donation count for the last 30 days - finer-grained trend for Analytics
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const dailyWhere = buildWhere({
        status: "completed",
        date: { $gte: thirtyDaysAgo },
        ...EXCLUDE_DONATIONS_PAGE,
      });
      const dailyAgg = await prisma.$queryRawUnsafe(
        `SELECT to_char("date", 'YYYY-MM-DD') AS "_id",
                COALESCE(SUM("amount"), 0) AS "donations",
                COUNT(*)::int AS "count"
           FROM "donations" ${dailyWhere.sql}
           GROUP BY 1
           ORDER BY 1`,
        ...dailyWhere.params
      );
      const dailyData = dailyAgg.map((d) => ({ date: d._id, donations: d.donations, count: d.count }));

      // Real recent-activity feed merged across collections (was hardcoded before)
      const [recentDonation, recentEvent, recentGallery, recentBlog, recentMessage] = await Promise.all([
        donationModel.findOne({ status: "completed", ...EXCLUDE_DONATIONS_PAGE }).sort({ createdAt: -1 }).select("amount sevaName type createdAt").lean(),
        eventModel.findOne().sort({ createdAt: -1 }).select("title createdAt").lean(),
        galleryModel.findOne().sort({ createdAt: -1 }).select("title images createdAt").lean(),
        blogModel.findOne({ status: "published" }).sort({ createdAt: -1 }).select("title createdAt").lean(),
        contactMessageModel.findOne().sort({ createdAt: -1 }).select("name subject createdAt").lean(),
      ]);
      const recentActivity = [
        recentDonation && {
          action: "New donation received",
          detail: `₹${recentDonation.amount?.toLocaleString("en-IN")} — ${recentDonation.sevaName || recentDonation.type || "General"}`,
          time: timeAgo(recentDonation.createdAt),
          at: recentDonation.createdAt,
        },
        recentEvent && {
          action: "Event created",
          detail: recentEvent.title,
          time: timeAgo(recentEvent.createdAt),
          at: recentEvent.createdAt,
        },
        recentGallery && {
          action: "Gallery updated",
          detail: `${recentGallery.images?.length || 1} photo(s) — ${recentGallery.title}`,
          time: timeAgo(recentGallery.createdAt),
          at: recentGallery.createdAt,
        },
        recentBlog && {
          action: "Blog published",
          detail: recentBlog.title,
          time: timeAgo(recentBlog.createdAt),
          at: recentBlog.createdAt,
        },
        recentMessage && {
          action: "New contact message",
          detail: `${recentMessage.name} — ${recentMessage.subject}`,
          time: timeAgo(recentMessage.createdAt),
          at: recentMessage.createdAt,
        },
      ].filter(Boolean).sort((a, b) => new Date(b.at) - new Date(a.at));

      res.status(200).json({
        stats: {
          totalDonations,
          // `donationAgg` was the old Mongo aggregation array; the query above now
          // resolves to a single row as `donationRow`. Referencing the old name threw
          // ReferenceError: donationAgg is not defined, so this endpoint 500'd on the
          // response build even once the SQL underneath it succeeded.
          donationCount: donationRow?.count || 0,
          donationChangePct,
          eventsThisMonth,
          galleryImages: galleryCount,
          galleryNewThisMonth,
          devoteesCount: distinctDonors,
          publishedBlogs: blogCount,
          newMessages: newMessagesCount,
        },
        monthlyData,
        sevaBreakdown,
        statusBreakdown,
        dailyData,
        recentActivity,
      });
    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  },
};

module.exports = { dashboardController };

// Offline verification of the Mongo-filter -> SQL WHERE compiler.
// Pure string/array work, so no database is needed. Every case mirrors a real
// $match stage from the controllers' aggregation pipelines.
const assert = require("node:assert");
const { buildWhere } = require("../src/lib/sqlFilter.js");

let pass = 0;
const fails = [];

function throws(name, filter, expectedFragment) {
  try {
    const r = buildWhere(filter);
    fails.push({ name, actual: `expected a throw, got: ${JSON.stringify(r)}` });
  } catch (e) {
    if (!e.message.includes(expectedFragment)) {
      fails.push({ name, actual: `threw, but message was: ${e.message}` });
    } else {
      pass++;
    }
  }
}

function check(name, filter, expectedSql, expectedParams) {
  try {
    const { sql, params } = buildWhere(filter);
    assert.strictEqual(sql, expectedSql, "SQL mismatch");
    if (expectedParams) assert.deepStrictEqual(params, expectedParams, "params mismatch");
    pass++;
  } catch (e) {
    let actual;
    try {
      actual = buildWhere(filter);
    } catch (err) {
      actual = `THREW: ${err.message}`;
    }
    fails.push({
      name,
      actual: `got:      ${JSON.stringify(actual)}\n      expected: ${JSON.stringify({
        sql: expectedSql,
        params: expectedParams,
      })}\n      assert:   ${e.message.split("\n").slice(0, 6).join(" | ")}`,
    });
  }
}

const EXCLUDE_DONATIONS_PAGE = { sourcePage: { $ne: "donations" } };

// ── the most common base filter in the codebase ───────────────────────────
check(
  "EXCLUDE_DONATIONS_PAGE",
  EXCLUDE_DONATIONS_PAGE,
  `WHERE "sourcePage"::text IS DISTINCT FROM $1`,
  ["donations"]
);

check("empty filter", {}, "", []);
check("plain equality", { slug: "my-post" }, `WHERE "slug"::text = $1`, ["my-post"]);
check("null means IS NULL", { receiptNumber: null }, `WHERE "receiptNumber" IS NULL`);

// ── ranges (date filters built from req.query) ─────────────────────────────
const from = new Date("2026-01-01T00:00:00.000Z");
const to = new Date("2026-01-31T23:59:59.999Z");
check(
  "date range",
  { createdAt: { $gte: from, $lte: to } },
  `WHERE "createdAt" >= $1 AND "createdAt" <= $2`,
  [from, to]
);
check("greater than", { amount: { $gt: 0 } }, `WHERE "amount" > $1`, [0]);
check("less than", { amount: { $lt: 100 } }, `WHERE "amount" < $1`, [100]);

// ── membership, incl. enum-backed columns ─────────────────────────────────
check(
  "$in casts the column to text (enum columns would otherwise fail)",
  { status: { $in: ["completed", "pending"] } },
  `WHERE "status"::text = ANY($1::text[])`,
  [["completed", "pending"]]
);
check("$in with an empty list matches nothing", { status: { $in: [] } }, `WHERE FALSE`);
check(
  "equality on an enum column casts to text (regression: 42883 on /dashboard/stats)",
  { status: "completed" },
  `WHERE "status"::text = $1`,
  ["completed"]
);
check(
  "a numeric value is NOT cast, so the column keeps its native type",
  { amount: 500 },
  `WHERE "amount" = $1`,
  [500]
);
check(
  "a Date value is NOT cast (casting a timestamp to text would compare formatted strings)",
  { date: new Date("2026-01-01T00:00:00.000Z") },
  `WHERE "date" = $1`,
  [new Date("2026-01-01T00:00:00.000Z")]
);
check(
  "$eq on an enum column casts too",
  { site: { $eq: "kakinada" } },
  `WHERE "site"::text = $1`,
  ["kakinada"]
);
check(
  "$nin also admits NULL, matching Mongo",
  { account: { $nin: ["touchstone"] } },
  `WHERE ("account" IS NULL OR NOT ("account"::text = ANY($1::text[])))`,
  [["touchstone"]]
);
check("$nin with an empty list adds no constraint", { account: { $nin: [] } }, "");

// ── $exists ───────────────────────────────────────────────────────────────
check(
  "$exists:false -> IS NULL",
  { whatsappReceiptSentAt: { $exists: false } },
  `WHERE "whatsappReceiptSentAt" IS NULL`
);
check(
  "$exists:true -> IS NOT NULL",
  { receiptNumber: { $exists: true } },
  `WHERE "receiptNumber" IS NOT NULL`
);

// ── regex ─────────────────────────────────────────────────────────────────
check(
  "$regex + $options i -> ILIKE",
  { donorName: { $regex: "krishna", $options: "i" } },
  `WHERE "donorName" ILIKE $1`,
  ["%krishna%"]
);
check(
  "$regex without options -> LIKE",
  { donorName: { $regex: "Shri" } },
  `WHERE "donorName" LIKE $1`,
  ["%Shri%"]
);
check(
  "bare RegExp",
  { name: /krishna/i },
  `WHERE "name" ILIKE $1`,
  ["%krishna%"]
);

// ── logical ───────────────────────────────────────────────────────────────
check(
  "$or",
  { $or: [{ status: "failed" }, { whatsappReceiptSentAt: null }] },
  `WHERE ("status"::text = $1 OR "whatsappReceiptSentAt" IS NULL)`,
  ["failed"]
);
check(
  "$and",
  { $and: [{ status: "completed" }, { site: "kakinada" }] },
  `WHERE ("status"::text = $1 AND "site"::text = $2)`,
  ["completed", "kakinada"]
);

// ── the real multi-clause stats filters ───────────────────────────────────
const startOfMonth = new Date("2026-09-01T00:00:00.000Z");
check(
  "completedBase + this month (donation.controller.js:72)",
  { ...EXCLUDE_DONATIONS_PAGE, status: "completed", createdAt: { $gte: startOfMonth } },
  `WHERE "sourcePage"::text IS DISTINCT FROM $1 AND "status"::text = $2 AND "createdAt" >= $3`,
  ["donations", "completed", startOfMonth]
);
check(
  "needsAttentionFilter (donation.controller.js:45)",
  {
    ...EXCLUDE_DONATIONS_PAGE,
    status: "completed",
    $or: [
      { dccSyncStatus: "failed" },
      { whatsappReceiptSentAt: { $exists: false } },
      { whatsappReceiptSentAt: null },
    ],
  },
  `WHERE "sourcePage"::text IS DISTINCT FROM $1 AND "status"::text = $2 ` +
    `AND ("dccSyncStatus"::text = $3 OR "whatsappReceiptSentAt" IS NULL OR "whatsappReceiptSentAt" IS NULL)`,
  ["donations", "completed", "failed"]
);

// ── _id alias ─────────────────────────────────────────────────────────────
check("_id maps to the id column", { _id: "abc" }, `WHERE "id"::text = $1`, ["abc"]);

// ── parameter numbering must stay sequential across nested clauses ────────
{
  const { sql, params } = buildWhere({
    $or: [{ status: "a" }, { status: "b" }],
    amount: { $gte: 10 },
  });
  try {
    assert.strictEqual(
      sql,
      `WHERE ("status"::text = $1 OR "status"::text = $2) AND "amount" >= $3`
    );
    assert.deepStrictEqual(params, ["a", "b", 10]);
    pass++;
  } catch {
    fails.push({ name: "parameter numbering is sequential and correct", actual: sql });
  }
}

// ── jsonb sub-document paths ──────────────────────────────────────────────
check(
  "dotted jsonb path becomes a ->> extraction",
  { "utm.campaign": "sqft" },
  `WHERE "utm"->>'campaign' = $1`,
  ["sqft"]
);
check(
  "deeper jsonb path",
  { "data.name": "x" },
  `WHERE "data"->>'name' = $1`,
  ["x"]
);
check(
  "jsonb path with $in",
  { "utm.medium": { $in: ["cpc", "email"] } },
  `WHERE "utm"->>'medium'::text = ANY($1::text[])`,
  [["cpc", "email"]]
);
check(
  "jsonb path with $regex (this is the UTM drill-down 'direct' bucket shape)",
  { "data.name": { $regex: "ravi", $options: "i" } },
  `WHERE "data"->>'name' ILIKE $1`,
  ["%ravi%"]
);

// ── $regex anchoring ───────────────────────────────────────────────────────
check(
  "$regex is a contains search when unanchored",
  { title: { $regex: "Puja" } },
  `WHERE "title" LIKE $1`,
  ["%Puja%"]
);
check(
  "^ becomes a prefix match",
  { title: { $regex: "^Shri" } },
  `WHERE "title" LIKE $1`,
  ["Shri%"]
);
check(
  "$ becomes a suffix match",
  { title: { $regex: "Puja$" } },
  `WHERE "title" LIKE $1`,
  ["%Puja"]
);
check(
  "both anchors become an exact match",
  { title: { $regex: "^Janmashtami$" } },
  `WHERE "title" LIKE $1`,
  ["Janmashtami"]
);
check(
  "LIKE wildcards in the user's term are escaped, not treated as wildcards",
  { title: { $regex: "100%_off" } },
  `WHERE "title" LIKE $1`,
  ["%100\\%\\_off%"]
);
throws(
  "regex features with no LIKE equivalent throw instead of mis-matching",
  { title: { $regex: "^(a|b)+" } },
  "LIKE translation cannot express"
);
throws(
  "jsonb path with a quote is rejected",
  { "utm->>'x' = 1 OR 1=1 --": 1 },
  "Refusing to build SQL"
);
check(
  "jsonb path IS NULL covers both a missing key and a JSON null",
  { "utm.source": null },
  `WHERE "utm"->>'source' IS NULL`
);

// ── injection guards ──────────────────────────────────────────────────────
const injections = [
  { name: "identifier with a semicolon", f: { "status; DROP TABLE donations": 1 } },
  { name: "identifier with a quote", f: { 'donor"Name': 1 } },
  { name: "identifier with a space", f: { "donor Name": 1 } },
  { name: "jsonb path with a quote", f: { "utm->>'x' = 1 OR 1=1 --": 1 } },
  { name: "jsonb path with a semicolon", f: { "utm.a; DROP TABLE x": 1 } },
];
for (const inj of injections) {
  let threw = false;
  try {
    buildWhere(inj.f);
  } catch {
    threw = true;
  }
  if (threw) pass++;
  else fails.push({ name: inj.name, actual: "did NOT throw" });
}

console.log(`\n  passed: ${pass}`);
if (fails.length) {
  console.log(`  FAILED: ${fails.length}\n`);
  for (const f of fails) {
    console.log(`  x ${f.name}`);
    console.log(`      ${f.actual}`);
  }
  process.exit(1);
} else {
  console.log("  all SQL compiler tests passed");
}

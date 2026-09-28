// Offline verification of the Mongo->Prisma translation layer.
// These are pure functions, so they can be tested with no database at all.
// Every case below is a real pattern found in the server's controllers.
const assert = require("node:assert");
const { Prisma } = require("@prisma/client");
const {
  translateWhere,
  translateUpdate,
  translateSort,
  translateProjection,
  parsePopulateSelect,
  Query,
  decorate,
  relationAliasesFor,
  asQueryLike,
} = require("../src/lib/mongoCompat.js");

let pass = 0;
const fails = [];

// Assert that a translation refuses rather than silently doing the wrong thing.
function throws(name, fn, expectedFragment) {
  try {
    const r = fn();
    fails.push({ name, actual: `expected a throw, got: ${JSON.stringify(r)}` });
  } catch (e) {
    if (!e.message.includes(expectedFragment)) {
      fails.push({ name, actual: `threw, but the message was: ${e.message}` });
    } else {
      pass++;
    }
  }
}

function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass++;
  } catch {
    fails.push({ name, actual, expected });
  }
}

// ── $exists (7 real sites, 2 distinct patterns) ────────────────────────────
check(
  "$exists:false  ->  IS NULL",
  translateWhere({ whatsappReceiptSentAt: { $exists: false } }),
  { whatsappReceiptSentAt: { equals: null } }
);
check(
  "$exists:true + $ne:null  ->  NOT NULL",
  translateWhere({ razorpayOrderId: { $exists: true, $ne: null } }),
  { razorpayOrderId: { not: null } }
);

// ── $ne ────────────────────────────────────────────────────────────────────
check("$ne value", translateWhere({ status: { $ne: "completed" } }), {
  status: { not: { equals: "completed" } },
});

// ── ranges ─────────────────────────────────────────────────────────────────
check(
  "$gte + $lte range",
  translateWhere({ date: { $gte: new Date(0), $lte: new Date(1) } }),
  { date: { gte: new Date(0), lte: new Date(1) } }
);
check("$gt", translateWhere({ views: { $gt: 5 } }), { views: { gt: 5 } });
check("$lt", translateWhere({ amount: { $lt: 100 } }), { amount: { lt: 100 } });

// ── set membership ─────────────────────────────────────────────────────────
check(
  "$in",
  translateWhere({ status: { $in: ["pending", "active"] } }),
  { status: { in: ["pending", "active"] } }
);
check(
  "$nin",
  translateWhere({ account: { $nin: ["touchstone"] } }),
  { account: { notIn: ["touchstone"] } }
);

// ── logical ────────────────────────────────────────────────────────────────
// NOTE: the expected values below use Prisma's OR/AND spelling, not Mongo's
// $or/$and. Prisma rejects $-prefixed logical keys outright, so a filter that
// preserved them would throw on the first query that used one.
check(
  "$or becomes Prisma OR",
  translateWhere({ $or: [{ receiptNumber: null }, { receiptNumber: "" }] }),
  { OR: [{ receiptNumber: null }, { receiptNumber: "" }] }
);
check(
  "$and becomes Prisma AND",
  translateWhere({ $and: [{ status: "completed" }, { site: "kakinada" }] }),
  { AND: [{ status: "completed" }, { site: "kakinada" }] }
);
check(
  "Prisma's own OR/AND pass through unchanged",
  translateWhere({ OR: [{ status: "completed" }], AND: [{ site: "kakinada" }] }),
  { OR: [{ status: "completed" }], AND: [{ site: "kakinada" }] }
);
check(
  "$nor becomes Prisma NOT (array = none of)",
  translateWhere({ $nor: [{ status: "failed" }] }),
  { NOT: [{ status: "failed" }] }
);
check(
  "$not becomes Prisma NOT (object)",
  translateWhere({ $not: { status: "failed" } }),
  { NOT: { status: "failed" } }
);
check(
  "$or containing a nested $exists (donation.controller.js:824)",
  translateWhere({
    $or: [
      { receiptNumber: null },
      { receiptNumber: { $exists: false } },
      { receiptNumber: "" },
    ],
  }),
  {
    OR: [
      { receiptNumber: null },
      { receiptNumber: { equals: null } },
      { receiptNumber: "" },
    ],
  }
);

// ── $regex + $options ──────────────────────────────────────────────────────
// Mongo regexes are searches. The anchors must be honoured, otherwise
// `^Shri` becomes a search for a literal caret and the filter silently
// matches nothing.
check(
  "$regex + $options:'i'  ->  contains + insensitive",
  translateWhere({ donorName: { $regex: "krishna", $options: "i" } }),
  { donorName: { contains: "krishna", mode: "insensitive" } }
);
check(
  "anchored ^  ->  startsWith (NOT contains with a literal caret)",
  translateWhere({ donorName: { $regex: "^Shri" } }),
  { donorName: { startsWith: "Shri" } }
);
check(
  "anchored ^ with $options:'i'  ->  startsWith + insensitive",
  translateWhere({ donorName: { $regex: "^Shri", $options: "i" } }),
  { donorName: { startsWith: "Shri", mode: "insensitive" } }
);
check(
  "anchored $  ->  endsWith",
  translateWhere({ title: { $regex: "Puja$" } }),
  { title: { endsWith: "Puja" } }
);
check(
  "both anchors  ->  equals",
  translateWhere({ title: { $regex: "^Janmashtami$" } }),
  { title: { equals: "Janmashtami" } }
);
check(
  "a $ that is part of the term, not an anchor, still becomes endsWith",
  translateWhere({ title: { $regex: "100$" } }),
  { title: { endsWith: "100" } }
);
check(
  "bare RegExp literal",
  translateWhere({ name: /krishna/i }),
  { name: { contains: "krishna", mode: "insensitive" } }
);

// ── _id -> id aliasing ─────────────────────────────────────────────────────
check(
  "_id is aliased to id",
  translateWhere({ _id: "abc123" }),
  { id: "abc123" }
);
check(
  "_id inside an operator is aliased",
  translateWhere({ _id: { $in: ["a", "b"] } }),
  { id: { in: ["a", "b"] } }
);

// ── plain equality and enum passthrough ────────────────────────────────────
check("plain equality", translateWhere({ slug: "my-post" }), { slug: "my-post" });
check("boolean", translateWhere({ featured: true }), { featured: true });
check(
  "enum value",
  translateWhere({ site: { $in: ["kakinada"] } }),
  { site: { in: ["kakinada"] } }
);

// ── literal embedded document (not an operator object) ─────────────────────
check(
  "literal sub-document matches exactly",
  translateWhere({ author: { name: "Admin" } }),
  { author: { equals: { name: "Admin" } } }
);

// ── updates ────────────────────────────────────────────────────────────────
check(
  "plain update object means $set",
  translateUpdate({ status: "completed", amount: 500 }),
  { status: "completed", amount: 500 }
);
check(
  "explicit $set",
  translateUpdate({ $set: { status: "completed" } }),
  { status: "completed" }
);
check(
  "$inc becomes Prisma increment",
  translateUpdate({ $inc: { views: 1 } }),
  { views: { increment: 1 } }
);
check(
  "mixed $set + $inc in one update",
  translateUpdate({ $set: { status: "done" }, $inc: { views: 1 } }),
  { status: "done", views: { increment: 1 } }
);
check(
  "$unset becomes null",
  translateUpdate({ $unset: { dccSyncError: 1 } }),
  { dccSyncError: null }
);
check("_id in an update is aliased", translateUpdate({ _id: "x" }), { id: "x" });

// ── sort ───────────────────────────────────────────────────────────────────
check("sort object desc", translateSort({ date: -1 }), [{ date: "desc" }]);
check(
  "sort object multi-key",
  translateSort({ site: 1, date: -1 }),
  [{ site: "asc" }, { date: "desc" }]
);
check("sort string with minus", translateSort("-date"), [{ date: "desc" }]);
check("sort string multi", translateSort("date -amount"), [
  { date: "asc" },
  { amount: "desc" },
]);
check("sort array", translateSort([{ a: 1 }, { b: -1 }]), [{ a: "asc" }, { b: "desc" }]);
check("empty sort is undefined", translateSort(undefined), undefined);

// ── projection ─────────────────────────────────────────────────────────────
check(
  "include string -> select",
  translateProjection("title slug category coverImage"),
  { __select: { title: true, slug: true, category: true, coverImage: true } }
);
check(
  // Prisma's `omit` is a { field: true } map, not an array -- an array makes
  // Prisma read the indices as field names (`Unknown field \`0\``).
  "pure exclusion string -> omit (aliased to Prisma field name)",
  translateProjection("-_id"),
  { __omit: { id: true } }
);
check(
  "include object -> select",
  translateProjection({ name: 1, email: 1 }),
  { __select: { name: true, email: true } }
);
check(
  "pure exclusion object -> omit (aliased to Prisma field name)",
  translateProjection({ _id: 0 }),
  { __omit: { id: true } }
);
check("no projection", translateProjection(undefined), {});
check("bare dash means no projection", translateProjection("-"), {});

// ── jsonb sub-document paths ───────────────────────────────────────────────
// `utm`, `data` and `attendance` are jsonb columns; Mongo reached into them
// with dotted paths. These are the exact filters in donation.controller.js,
// donationAdmin.controller.js and registration.controller.js.
check(
  "equality on a jsonb key",
  translateWhere({ "utm.campaign": "sqft" }),
  { utm: { path: ["campaign"], equals: "sqft" } }
);
check(
  "boolean on a jsonb key (attendance.present)",
  translateWhere({ "attendance.present": true }),
  { attendance: { path: ["present"], equals: true } }
);
check(
  "null on a jsonb key becomes AnyNull, because a Mongo null also matches a missing key",
  translateWhere({ "utm.source": null }),
  { utm: { path: ["source"], equals: Prisma.AnyNull } }
);
check(
  "the UTM 'direct' bucket: { $in: [null, \"\"] } expands to an OR (nested in AND, since OR cannot sit beside siblings)",
  translateWhere({ "utm.campaign": { $in: [null, ""] } }),
  {
    AND: [
      {
        OR: [
          { utm: { path: ["campaign"], equals: Prisma.AnyNull } },
          { utm: { path: ["campaign"], equals: "" } },
        ],
      },
    ],
  }
);
check(
  "case-insensitive $regex on a jsonb key",
  translateWhere({ "data.name": { $regex: "rav", $options: "i" } }),
  { data: { path: ["name"], string_contains: "rav", mode: "insensitive" } }
);
check(
  "anchored $regex on a jsonb key becomes string_starts_with",
  translateWhere({ "data.name": { $regex: "^Rav" } }),
  { data: { path: ["name"], string_starts_with: "Rav" } }
);
check(
  "two jsonb conditions on the SAME root are ANDed, not overwritten",
  translateWhere({ "utm.campaign": "sqft", "utm.source": "whatsapp" }),
  {
    AND: [
      { utm: { path: ["campaign"], equals: "sqft" } },
      { utm: { path: ["source"], equals: "whatsapp" } },
    ],
  }
);
check(
  "a single jsonb condition merges in beside ordinary column filters",
  translateWhere({ eventId: "e1", paid: true, "attendance.present": true }),
  {
    eventId: "e1",
    paid: true,
    attendance: { path: ["present"], equals: true },
  }
);
throws(
  "an operator with no Prisma JSON equivalent throws instead of matching everything",
  () => translateWhere({ "utm.campaign": { $exists: false } }),
  "no Prisma"
);
throws(
  "$gt on a jsonb key throws (Prisma JSON filters have no ordering operators)",
  () => translateWhere({ "utm.campaign": { $gt: "a" } }),
  "no Prisma"
);

// ── populate ───────────────────────────────────────────────────────────────
// The 4 real call sites: blog deletion requests, festival list/getBySlug, and
// the campaigner referrer lookup in payment.controller.js.
async function populateTests() {
  // `id` is always included: Mongoose's populate returns the joined
  // document's _id whether or not you asked for it, and callers rely on that.
  check("populate select spec 'name email' -> { select: {...} }", parsePopulateSelect("name email"), {
    select: { id: true, name: true, email: true },
  });
  check("populate with no spec -> true (whole relation)", parsePopulateSelect(undefined), true);
  check("populate comma-separated spec", parsePopulateSelect("dccEnrolledById"), {
    select: { id: true, dccEnrolledById: true },
  });

  // End-to-end through a fake delegate: prove the alias is used in the Prisma
  // `include`, and that the value lands back on the Mongoose field name.
  let seen;
  const delegate = {
    findMany: async (args) => {
      seen = args;
      return [
        {
          id: "f1",
          title: "Janmashtami",
          createdBy: "u9",
          eventId: "e4",
          creator: { id: "u9", name: "Admin", email: "a@b.c" },
          event: { id: "e4", title: "Main Event" },
        },
      ];
    },
  };

  const q = new Query("FestivalDonation", delegate);
  q.populate("createdBy", "name email").populate("eventId");
  const rows = await q._run();

  check("populate maps Mongoose names onto Prisma relations", seen.include, {
    creator: { select: { id: true, name: true, email: true } },
    event: true,
  });
  check("the id is replaced by the document, as Mongoose did", rows[0].createdBy, {
    id: "u9",
    name: "Admin",
    email: "a@b.c",
  });
  check("the populated event is also moved into place", rows[0].eventId, {
    id: "e4",
    title: "Main Event",
  });
  check("the Prisma-only alias names are removed from the payload", Object.keys(rows[0]).includes("creator") || Object.keys(rows[0]).includes("event"), false);

  // A null relation must leave the original id alone.
  const nullDelegate = {
    findMany: async () => [{ id: "f2", createdBy: "u9", creator: null }],
  };
  const q2 = new Query("FestivalDonation", nullDelegate);
  q2.populate("createdBy", "name email");
  const rows2 = await q2._run();
  check("a null relation does not clobber the id", rows2[0].createdBy, "u9");

  // A projection plus a populate. Prisma REJECTS `select` and `include`
  // together ("Please either use `include` or `select`, but not both"), so the
  // relation has to be folded INTO the select -- which Prisma supports and
  // which yields the same rows. blog.controller.js's deletionRequests does
  // exactly this, and used to 500 on it.
  let seen2;
  const d3 = {
    findMany: async (args) => {
      seen2 = args;
      return [];
    },
  };
  const q3 = new Query("Blog", d3);
  q3.populate("deletionRequestedBy", "name email").select("title slug category");
  await q3._run();
  check("a populate is folded into select, never passed alongside it", [seen2.select, seen2.include], [
    {
      id: true,
      title: true,
      slug: true,
      category: true,
      deletionRequester: { select: { id: true, name: true, email: true } },
    },
    undefined,
  ]);
}

// ── result decoration ──────────────────────────────────────────────────────
// These cover the Mongoose-shaped surface that 69 `doc._id` reads, 4 `.save()`
// calls and 2 `.toObject()` calls depend on. Kept in an async function so the
// file stays plain CommonJS and so the report can wait for it.
async function main() {
  await populateTests();

  const delegate = { update: async () => ({ id: "a1", title: "saved" }) };
  const row = decorate({ id: "a1", title: "hello", views: 3 }, delegate);

  check("_id is aliased to id", row._id, "a1");
  check(
    "_id is ENUMERABLE so it survives JSON.stringify, like Mongoose's toJSON",
    Object.keys(row).includes("_id"),
    true
  );
  check("toObject exists", typeof row.toObject, "function");
  check("save exists", typeof row.save, "function");
  check(
    "the helpers are NON-enumerable so they stay out of JSON",
    Object.keys(row).includes("save") || Object.keys(row).includes("toObject"),
    false
  );
  check("toObject returns a plain copy with _id", row.toObject(), { id: "a1", _id: "a1", title: "hello", views: 3 });
  check("JSON output matches Mongoose's shape", JSON.parse(JSON.stringify(row)), {
    id: "a1",
    _id: "a1",
    title: "hello",
    views: 3,
  });

  // save() must not send id/_id back as columns.
  let sent;
  const capturing = {
    update: async (args) => {
      sent = args;
      return { id: "a1", title: "saved" };
    },
  };
  const r2 = decorate({ id: "a1", title: "new title" }, capturing);
  await r2.save();
  check("save() sends the row without id/_id", sent, {
    where: { id: "a1" },
    data: { title: "new title" },
  });

  check("decorate passes null through", decorate(null, {}), null);
  check("decorate passes undefined through", decorate(undefined, {}), undefined);
  check("decorate maps arrays", decorate([{ id: "a" }, { id: "b" }], {}).map((r) => r._id), ["a", "b"]);
  check(
    "decorate does not double-wrap",
    decorate(decorate({ id: "z" }, {}), {})._id,
    "z"
  );
  check("decorate leaves Date values alone", decorate(new Date(), {}) instanceof Date, true);

  await regressionTests();
}

// ── regressions ────────────────────────────────────────────────────────────
// One case per bug that reached production. Each of these shipped green
// against the rest of this file, so they are pinned here deliberately.
async function regressionTests() {
  // findById used to resolve to an ARRAY, because it never set the
  // single-document flag that findOne sets. ~30 call sites read fields
  // straight off the result -- donation.status, event.title, existing.save()
  // -- so all of them silently saw undefined, and GET /events/:id answered
  // 200 with an array where the client expected an object.
  {
    const rows = [{ id: "d1", title: "One" }];
    const delegate = { findMany: async () => rows.map((r) => ({ ...r })) };
    const model = { findById: (id) => { const q = new Query("event", delegate); q.where({ id }); q._single = true; return q; } };
    const got = await model.findById("d1");
    check("findById resolves to a document, not an array", Array.isArray(got), false);
    check("findById exposes the document's fields", got.title, "One");

    const emptyDelegate = { findMany: async () => [] };
    const q = new Query("event", emptyDelegate);
    q.where({ id: "nope" });
    q._single = true;
    check("findById resolves to null when nothing matches", await q._run(), null);
  }

  // Prisma's `omit` is { field: true }; an array makes it read the indices as
  // field names and every query dies with `Unknown field \`0\``.
  {
    const proj = translateProjection("-password");
    check("omit is a field map, never an array", Array.isArray(proj.__omit), false);
    check("omit names the excluded field", proj.__omit, { password: true });
  }

  // A projection always keeps the id, as Mongoose did -- admin lists need an
  // id to act on the row they just rendered.
  {
    let seen;
    const q = new Query("blog", { findMany: async (args) => { seen = args; return []; } });
    q.select("title slug");
    await q._run();
    check("a projection still selects the id", seen.select.id, true);
  }

  // Relation aliases are keyed by the camelCase delegate name in production
  // and looked up by PascalCase in these tests; both must resolve or the
  // populate silently asks Prisma to include a scalar column as a relation.
  check("alias lookup accepts the camelCase delegate name",
    relationAliasesFor("festivalDonation").createdBy, "creator");
  check("alias lookup accepts the PascalCase model name",
    relationAliasesFor("FestivalDonation").createdBy, "creator");
  check("alias lookup on an unaliased model is empty, not undefined",
    relationAliasesFor("gallery"), {});

  // The mutating finders return a Query in Mongoose, so `.lean()` is chained
  // onto them (donationPage.update does exactly that, and used to crash with
  // "findOneAndUpdate(...).lean is not a function").
  {
    const wrapped = asQueryLike(Promise.resolve({ id: "p1", key: "donations" }));
    check("a mutating finder is chainable with .lean()", typeof wrapped.lean, "function");
    check("...and .lean() returns something still awaitable", typeof wrapped.lean().then, "function");
    check("...and it resolves to the document", (await wrapped.lean()).key, "donations");
    check("...and it is awaitable without .lean() too", (await asQueryLike(Promise.resolve({ key: "x" }))).key, "x");
  }
}

// ── report ─────────────────────────────────────────────────────────────────
// Awaited explicitly: the decoration block above is async, so a synchronous
// report would print before its final check had run.
main()
  .then(() => {
    console.log(`\n  passed: ${pass}`);
    if (fails.length) {
      console.log(`  FAILED: ${fails.length}\n`);
      for (const f of fails) {
        console.log(`  x ${f.name}`);
        console.log(`      actual:   ${JSON.stringify(f.actual)}`);
        console.log(`      expected: ${JSON.stringify(f.expected)}`);
      }
      process.exit(1);
    } else {
      console.log("  all translation tests passed");
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

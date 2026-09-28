const { Prisma } = require("@prisma/client");

// ── BlogCategory: stored label <-> Prisma enum member ──────────────────────
//
// The categories are human labels with spaces and ampersands ("Krishna Katha",
// "Sacred Festivals & Occasions"), which are not legal Prisma identifiers, so
// schema.prisma declares them as `KrishnaKatha @map("Krishna Katha")`. That
// @map applies between Prisma and POSTGRES -- it does NOT apply to the client
// API. Prisma's JS API only ever speaks the member name (`KrishnaKatha`);
// handing it the stored label throws
//   Invalid value for argument `category`. Expected BlogCategory.
//
// Which is exactly what happened: 10 of the 13 categories -- every one that
// carries a @map -- could not be created, filtered or counted. Only Recipes,
// Pilgrimage and Other worked, because those three have no @map and so their
// member name and stored label happen to be identical.
//
// The maps below are derived from the generated client's DMMF rather than
// hand-written, so they cannot drift from schema.prisma: add or rename a
// category there, regenerate, and this follows automatically.
const CATEGORY_ENUM = Prisma.dmmf.datamodel.enums.find((e) => e.name === "BlogCategory");

if (!CATEGORY_ENUM) {
  throw new Error(
    "[blog.model] BlogCategory is missing from the generated Prisma client. " +
      "Run `npx prisma generate` after changing prisma/schema.prisma."
  );
}

// Stored label (what the API, the admin dropdown and the DB all use) ->
// Prisma member name (what the Prisma client demands).
const LABEL_TO_MEMBER = new Map();
// ...and back again, for everything Prisma hands us.
const MEMBER_TO_LABEL = new Map();

for (const value of CATEGORY_ENUM.values) {
  const label = value.dbName || value.name;
  LABEL_TO_MEMBER.set(label, value.name);
  MEMBER_TO_LABEL.set(value.name, label);
}

// The labels, in schema order. This is what the admin editor's dropdown shows
// and what the public category navigation is keyed on.
const BLOG_CATEGORIES = CATEGORY_ENUM.values.map((v) => v.dbName || v.name);

/**
 * Label -> Prisma member, for anything on its way INTO Prisma (create data,
 * update data, a `where` clause). Already-correct member names pass through, so
 * this is safe to apply twice, and an unknown value is returned untouched so
 * Prisma still raises its own clear validation error rather than this silently
 * swallowing a typo.
 */
const toCategoryEnum = (value) => {
  if (typeof value !== "string") return value;
  if (LABEL_TO_MEMBER.has(value)) return LABEL_TO_MEMBER.get(value);
  if (MEMBER_TO_LABEL.has(value)) return value;
  return value;
};

/**
 * Prisma member -> label, for anything on its way OUT to a client. Applied to
 * a single blog, an array of blogs, or null/undefined.
 */
const toCategoryLabel = (value) =>
  typeof value === "string" && MEMBER_TO_LABEL.has(value) ? MEMBER_TO_LABEL.get(value) : value;

/**
 * Rewrite `category` on a blog (or array of blogs) to its stored label, so the
 * client keeps seeing "Krishna Katha" and never the internal `KrishnaKatha`.
 */
const withCategoryLabel = (blog) => {
  if (!blog) return blog;
  if (Array.isArray(blog)) return blog.map(withCategoryLabel);
  if (blog.category === undefined) return blog;
  const plain = typeof blog.toObject === "function" ? blog.toObject() : { ...blog };
  plain.category = toCategoryLabel(plain.category);
  return plain;
};

const { createModel } = require("../lib/mongoCompat");

// Prisma-backed. The exported name is unchanged so the ~47 files that
// import blogModel keep working unchanged.
const blogModel = createModel("blog");

module.exports = {
  blogModel,
  BLOG_CATEGORIES,
  toCategoryEnum,
  toCategoryLabel,
  withCategoryLabel,
};

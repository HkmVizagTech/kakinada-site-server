// Compile a Mongo-style filter object into a parameterised SQL WHERE clause.
//
// The reporting queries in this codebase are aggregation pipelines, and each
// one begins with the same `$match` stage: a status, a date range, a
// sourcePage exclusion, sometimes an `$or` block. Rather than hand-rolling
// that WHERE clause 25 times -- where one forgotten `:param` would turn a
// filter into a syntax error and one forgotten quote into an injection --
// the pipelines reuse the filter objects they already had, and this turns
// them into safe SQL.
//
// Values are ALWAYS bound as parameters. Identifiers cannot be bound, so
// field names are validated against a strict allowlist pattern and
// double-quoted; anything else throws instead of being interpolated.

const { translateWhere } = require("./mongoCompat");

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Prisma's primary key is `id`; the rest of the field names are camelCase and
// used verbatim as quoted column names.
const COLUMN_ALIAS = { _id: "id" };

class Params {
  constructor() {
    this.values = [];
  }

  add(value) {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

// Sub-documents that Mongoose stored inline became jsonb columns (utm,
// prasadamAddress, author, attendance, data, ...). Mongo addressed them with
// dotted paths -- `utm.campaign` -- so those become Postgres jsonb extractions.
// `->>` yields text, which is what the surrounding comparisons expect.
function column(name) {
  if (name.includes(".")) {
    const segments = name.split(".");
    const root = COLUMN_ALIAS[segments[0]] || segments[0];
    const rest = segments.slice(1);
    if (!IDENTIFIER.test(root) || rest.some((s) => !PATH_SEGMENT.test(s))) {
      throw new Error(
        `[sqlFilter] Refusing to build SQL for JSON path "${name}". ` +
          `Each segment must match ${PATH_SEGMENT}.`
      );
    }
    return `"${root}"->>'${rest[0]}'` + rest.slice(1).map((s) => `->>'${s}'`).join("");
  }

  const resolved = COLUMN_ALIAS[name] || name;
  if (!IDENTIFIER.test(resolved)) {
    throw new Error(
      `[sqlFilter] Refusing to build SQL for column name "${name}". ` +
        `Column names must match ${IDENTIFIER}.`
    );
  }
  return `"${resolved}"`;
}

// Prisma maps a number of columns to Postgres ENUM types -- Donation.status is
// "DonationStatus", Donation.site is "DonationSite", dccSyncStatus, role,
// category and friends are the same. Postgres has no `enum = text` operator, so
// a bound string on one of those columns fails outright:
//
//   ERROR: operator does not exist: "DonationStatus" = text  (SQLSTATE 42883)
//
// That is exactly what broke GET /dashboard/stats. $in already worked around it
// by casting the column to text; equality and $ne need the same treatment, or
// every enum filter in a reporting query is a 500.
//
// The cast is applied ONLY when the bound value is a string, so date and
// numeric comparisons keep their native types (casting a timestamp to text
// would compare formatted strings, which is both slower and wrong). A jsonb
// `->>` extraction already yields text and is left alone.
//
// Cost: an index on the compared column cannot be used. buildWhere is only
// used by the dashboard reporting queries, which aggregate the whole table
// anyway, so this is the same trade $in already made.
function comparable(field, value) {
  const col = column(field);
  if (typeof value === "string" && !field.includes(".")) return `${col}::text`;
  return col;
}

/**
 * Compile one field/value pair into a SQL boolean expression.
 * Returns null when the pair adds no constraint.
 */
// `%` and `_` are wildcards inside LIKE, and `\` is LIKE's default escape
// character, so a user-supplied term containing them has to be neutralised or
// "100%" would match "1000%" too.
function escapeLike(literal) {
  return literal.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Same anchoring rules as the Prisma translator: a bare pattern is a contains
// search, `^` is a prefix, `$` a suffix, and both together an exact match.
// Anything needing real regex semantics throws rather than being flattened.
function regexToLikePattern(pattern) {
  if (pattern instanceof RegExp) pattern = pattern.source;
  if (typeof pattern !== "string") {
    throw new Error("[sqlFilter] $regex pattern must be a string or RegExp.");
  }
  if (/[\\^$.|?*+()[\]{}]/.test(pattern.replace(/^\^/, "").replace(/\$$/, ""))) {
    throw new Error(
      `[sqlFilter] $regex "${pattern}" uses regex features (classes, quantifiers, ` +
        `alternation) that a LIKE translation cannot express. Use Postgres ~ or ~* directly.`
    );
  }

  const startsWithCaret = pattern.startsWith("^");
  const endsWithDollar = pattern.endsWith("$") && !pattern.endsWith("\\$");
  const core = escapeLike(pattern.replace(/^\^/, "").replace(/\$$/, ""));

  if (startsWithCaret && endsWithDollar) return core;
  if (startsWithCaret) return `${core}%`;
  if (endsWithDollar) return `%${core}`;
  return `%${core}%`;
}

function compileValue(field, value, params) {
  if (value instanceof RegExp) {
    const insensitive = value.flags.includes("i");
    return `${column(field)} ${insensitive ? "ILIKE" : "LIKE"} ${params.add(
      regexToLikePattern(value)
    )}`;
  }

  const isOperatorObject =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date);

  if (!isOperatorObject) {
    if (value === null) return `${column(field)} IS NULL`;
    return `${comparable(field, value)} = ${params.add(value)}`;
  }

  const parts = [];
  for (const [op, operand] of Object.entries(value)) {
    switch (op) {
      case "$eq":
        parts.push(
          operand === null
            ? `${column(field)} IS NULL`
            : `${comparable(field, operand)} = ${params.add(operand)}`
        );
        break;
      case "$ne":
        // Mongo's $ne also matches documents where the field is absent, which
        // in Postgres is simply NULL. `IS DISTINCT FROM` covers both.
        parts.push(`${comparable(field, operand)} IS DISTINCT FROM ${params.add(operand)}`);
        break;
      case "$gt":
        parts.push(`${column(field)} > ${params.add(operand)}`);
        break;
      case "$gte":
        parts.push(`${column(field)} >= ${params.add(operand)}`);
        break;
      case "$lt":
        parts.push(`${column(field)} < ${params.add(operand)}`);
        break;
      case "$lte":
        parts.push(`${column(field)} <= ${params.add(operand)}`);
        break;
      case "$in":
        if (!operand.length) {
          parts.push("FALSE");
          break;
        }
        // The column is cast to text because Prisma maps some fields to
        // Postgres ENUMs (status, site, dccSyncStatus) and Postgres has no
        // `enum = text` operator -- comparing an enum column directly against
        // a text[] raises "operator does not exist". The cast costs the use of
        // an index on that column, which is an acceptable trade for the
        // reporting queries that use this helper.
        parts.push(`${column(field)}::text = ANY(${params.add(operand)}::text[])`);
        break;
      case "$nin":
        if (!operand.length) break;
        parts.push(
          `(${column(field)} IS NULL OR NOT (${column(field)}::text = ANY(${params.add(operand)}::text[])))`
        );
        break;
      case "$exists":
        parts.push(operand === false ? `${column(field)} IS NULL` : `${column(field)} IS NOT NULL`);
        break;
          case "$regex": {
            const insensitive = value.$options && value.$options.includes("i");
            parts.push(
              `${column(field)} ${insensitive ? "ILIKE" : "LIKE"} ${params.add(
                regexToLikePattern(operand)
              )}`
            );
            break;
          }
      case "$options":
        break;
      default:
        throw new Error(
          `[sqlFilter] Operator "${op}" on "${field}" has no SQL equivalent here. ` +
            `Add it deliberately rather than silently dropping the filter.`
        );
    }
  }
  return parts.length ? parts.join(" AND ") : null;
}

/**
 * Build a WHERE clause (or "") from a Mongo filter object.
 * Returns { sql, params } where `params` is the positional $1,$2,... values.
 */
function buildWhere(filter) {
  if (!filter || typeof filter !== "object") return { sql: "", params: [] };

  const params = new Params();
  const parts = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const joiner = key === "$or" ? " OR " : " AND ";
      const compiled = value
        .map((clause) => compileObject(clause, params))
        .filter(Boolean);
      if (compiled.length) parts.push(`(${compiled.join(joiner)})`);
      continue;
    }
    if (key === "$nor") {
      const compiled = value.map((clause) => compileObject(clause, params)).filter(Boolean);
      if (compiled.length) parts.push(`NOT (${compiled.join(" OR ")})`);
      continue;
    }
    if (key === "$not") {
      const compiled = compileObject(value, params);
      if (compiled) parts.push(`NOT (${compiled})`);
      continue;
    }

    const compiled = compileValue(key, value, params);
    if (compiled) parts.push(compiled);
  }

  return {
    sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params: params.values,
  };
}

function compileObject(filter, params) {
  if (!filter || typeof filter !== "object") return null;
  const parts = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$or" || key === "$and") {
      const joiner = key === "$or" ? " OR " : " AND ";
      const inner = value.map((c) => compileObject(c, params)).filter(Boolean);
      if (inner.length) parts.push(`(${inner.join(joiner)})`);
      continue;
    }
    const compiled = compileValue(key, value, params);
    if (compiled) parts.push(compiled);
  }
  return parts.length ? parts.join(" AND ") : null;
}

module.exports = { buildWhere, translateWhere };

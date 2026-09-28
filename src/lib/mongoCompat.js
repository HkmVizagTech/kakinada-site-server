// Mongo-flavoured query layer over Prisma.
//
// WHY THIS EXISTS
// ---------------
// The controllers were written directly against the Mongoose API: ~470 query
// call sites across 47 files, written by hand over years. Rewriting all of
// them by hand in one pass would mean re-deriving ~445 query translations
// with no test suite and no live database to check them against, which in a
// donation-processing system is how you get a silently wrong filter that
// quietly drops a payment from a report.
//
// So this is a deliberate anti-corruption layer. It implements the exact
// subset of the Mongoose API this codebase uses, and nothing more, mapping it
// onto Prisma. The operator set was measured, not guessed -- see the audit in
// the commit message: $gte $lte $gt $lt $ne $in $nin $or $and $regex $options
// $exists $inc $set. There are no $push, $addToSet, $type, $where or
// aggregation-operator filters in the codebase.
//
// Anything NOT covered here throws loudly rather than guessing:
//   * .aggregate()  -- ported by hand to $queryRaw (all 25 sites, done)
//   * .populate()   -- ported by hand to `include` (6 sites)
//
// This layer is transitional. Once every call site is native Prisma it
// should be deleted; do not extend it with new Mongo features.

const { prisma } = require("./prisma");

// ── field name mapping ─────────────────────────────────────────────────────
// Mongoose exposes the primary key as `_id`; Prisma names it `id`.
const ID_ALIASES = { _id: "id" };

const mapKey = (key) => ID_ALIASES[key] || key;

const { Prisma } = require("@prisma/client");

/**
 * Build the Prisma filter for one dotted path into a jsonb sub-document, e.g.
 * `utm.campaign`. Mongo addressed these inside embedded docs; in Postgres they
 * live inside a jsonb column, which Prisma filters through `path`.
 *
 * Returns a single Prisma where-fragment, or throws when the requested
 * comparison has no Prisma equivalent. `string_contains`/`mode` on a JSON
 * filter is supported (verified in the generated client types), which is what
 * makes the case-insensitive `data.name` search in registration.controller.js
 * expressible without dropping to raw SQL.
 */
function jsonPathFilter(key, value) {
  const [root, ...path] = key.split(".");

  const isOperatorObject =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp);

  // Plain equality, including an explicit null.
  if (!isOperatorObject) {
    // AnyNull rather than null: a Mongo `{ field: null }` matches a key that is
    // absent as well as one explicitly set to null, which `equals: null` does
    // not (it compiles to `= NULL`, which is never true).
    return { [root]: { path, equals: value === null ? Prisma.AnyNull : value } };
  }

  if (value instanceof RegExp) {
    const parsed = regexToPrisma(value);
    if (!parsed) {
      throw new Error(
        `[mongoCompat] RegExp /${value.source}/${value.flags} on jsonb path "${key}" ` +
          `cannot be translated.`
      );
    }
    const op = { contains: "string_contains", startsWith: "string_starts_with", endsWith: "string_ends_with", equals: "string_contains" }[parsed.op];
    return { [root]: { path, [op]: parsed.value, mode: value.flags.includes("i") ? "insensitive" : undefined } };
  }

  const keys = Object.keys(value);

  // { $in: [...] } over a jsonb key has no direct Prisma equivalent, but it is
  // exactly an OR of the individual equalities, so expand it.
  if (keys.includes("$in")) {
    const list = value.$in;
    if (!Array.isArray(list)) {
      throw new Error(`[mongoCompat] $in on jsonb path "${key}" must be an array.`);
    }
    if (list.length === 0) return { [root]: { path, equals: Prisma.AnyNull } };
    const clauses = list.map((v) => jsonPathFilter(key, v));
    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }

  if (keys.includes("$regex")) {
    const parsed = regexToPrisma(value.$regex);
    if (!parsed) {
      throw new Error(
        `[mongoCompat] $regex "${value.$regex}" on jsonb path "${key}" uses regex ` +
          `features with no Prisma equivalent.`
      );
    }
    const op = { contains: "string_contains", startsWith: "string_starts_with", endsWith: "string_ends_with", equals: "string_contains" }[parsed.op];
    const insensitive = value.$options && value.$options.includes("i");
    return { [root]: { path, [op]: parsed.value, ...(insensitive ? { mode: "insensitive" } : {}) } };
  }

  throw new Error(
    `[mongoCompat] ${keys.join(", ")} on jsonb path "${key}" has no Prisma ` +
      `equivalent. Prisma's JSON filter only supports equality, $in (as an OR ` +
      `of equalities) and $regex (as string_contains/starts_with/ends_with).`
  );
}

// ── comparison operator mapping ────────────────────────────────────────────
const OPERATOR_MAP = {
  $gte: "gte",
  $gt: "gt",
  $lte: "lte",
  $lt: "lt",
  $in: "in",
  $nin: "notIn",
  $not: "not",
  $contains: "contains",
  $startsWith: "startsWith",
  $endsWith: "endsWith",
  $mode: "mode",
};

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);

      /**
       * Mongo regexes are searches, not full matches. A pattern with no anchors
       * means "contains"; with anchors it means startsWith/endsWith/exactly.
       * Flattening everything to `contains` silently turns `^Shri` into a
       * search for a literal caret, which is why the anchors are parsed here.
       * Returns null for patterns that need real regex semantics (character
       * classes, quantifiers, alternation) -- those have no Prisma equivalent
       * and must be handled by the caller in raw SQL.
       */
      function regexToPrisma(pattern) {
        if (pattern instanceof RegExp) pattern = pattern.source;
        if (typeof pattern !== "string") return null;

        // Peel the anchors off first, then look for metacharacters in what is
        // left. Testing before peeling would flag the anchors themselves and
        // reject every anchored pattern.
        const startsWithCaret = pattern.startsWith("^");
        const endsWithDollar = pattern.endsWith("$") && !pattern.endsWith("\\$");
        const core = pattern.replace(/^\^/, "").replace(/\$$/, "");
        if (!core || /[\\^$.|?*+()[\]{}]/.test(core)) return null;

        if (startsWithCaret && endsWithDollar) return { op: "equals", value: core };
        if (startsWithCaret) return { op: "startsWith", value: core };
        if (endsWithDollar) return { op: "endsWith", value: core };
        return { op: "contains", value: core };
      }

      /**
       * Translate one Mongo filter value into its Prisma equivalent.
       */
      function translateValue(value) {
        // A bare RegExp literal: { name: /krishna/i }
        if (value instanceof RegExp) {
          const parsed = regexToPrisma(value);
          if (!parsed) {
            throw new Error(
              `[mongoCompat] RegExp /${value.source}/${value.flags} uses regex features ` +
                `with no Prisma equivalent. Rewrite this filter in raw SQL.`
            );
          }
          return {
            [parsed.op]: parsed.value,
            ...(value.flags.includes("i") ? { mode: "insensitive" } : {}),
          };
        }

  if (!isPlainObject(value)) return value;

  // A Date is technically an object, handled above. Everything else here is
  // an operator object like { $gte: 5, $lte: 10 }.
  const out = {};
  let matchedOperator = false;

  for (const [op, operand] of Object.entries(value)) {
    switch (op) {
      // Postgres columns are NULL or not -- there is no "missing document
      // field", so $exists maps exactly onto a null test.
      case "$exists":
        matchedOperator = true;
        if (operand === false) {
          Object.assign(out, { equals: null });
        } else {
          Object.assign(out, { not: null });
        }
        break;

      case "$ne":
        matchedOperator = true;
        // { $ne: null } means "not null" in Prisma; a plain value means
        // "not equal".
        out.not = operand === null ? null : { equals: operand };
        break;

          case "$regex": {
            matchedOperator = true;
            const parsed = regexToPrisma(operand);
            if (!parsed) {
              throw new Error(
                `[mongoCompat] $regex "${operand}" uses regex features with no ` +
                  `Prisma equivalent. Rewrite this filter in raw SQL.`
              );
            }
            out[parsed.op] = parsed.value;
            break;
          }

      case "$options": {
        matchedOperator = true;
        // Mongo spells case-insensitivity as /i; Prisma spells it "insensitive".
        if (typeof operand === "string" && operand.includes("i")) {
          out.mode = "insensitive";
        }
        break;
      }

      case "$eq":
        matchedOperator = true;
        out.equals = operand;
        break;

      default:
        if (OPERATOR_MAP[op]) {
          matchedOperator = true;
          out[OPERATOR_MAP[op]] = Array.isArray(operand)
            ? operand.map((v) => translateValue(v))
            : translateValue(operand);
        }
    }
  }

  // No recognised operator: the object is a literal sub-document value, so
  // match it exactly (translated recursively, since it may itself contain
  // nested documents).
  if (!matchedOperator) {
    const literal = {};
    for (const [k, v] of Object.entries(value)) {
      literal[mapKey(k)] = translateValue(v);
    }
    return { equals: literal };
  }

  return out;
}

/**
 * Translate a whole Mongo `where` clause into a Prisma `where`.
 */
function translateWhere(filter) {
  if (!filter || typeof filter !== "object") return {};

  const where = {};
  // Conditions on jsonb sub-documents (utm.campaign, data.name, ...) become
  // Prisma JSON-path filters. Several of them can target the same root column
  // (utm.campaign AND utm.source), and each is a complete fragment, so they are
  // collected and combined with AND rather than assigned -- assigning would let
  // the second one silently replace the first.
  const jsonClauses = [];
  // Field conditions that cannot be expressed as a single `where[field]` value
  // -- currently the null-bearing $in/$nin rewrites below. Merged into AND.
  const nullableClauses = [];

  for (const [key, value] of Object.entries(filter)) {
    // Mongo's $or/$and become Prisma's OR/AND. Prisma does NOT understand the
    // $-prefixed spellings, so passing them through produces a filter that
    // Prisma rejects at runtime rather than one it silently ignores.
    if (key === "$or" || key === "$and" || key === "AND" || key === "OR") {
      const target = key === "AND" || key === "$and" ? "AND" : "OR";
      const list = value.map(translateWhere);
      where[target] = where[target] ? [where[target], ...list] : list;
      continue;
    }
    if (key === "$nor") {
      where.NOT = value.map(translateWhere);
      continue;
    }
    if (key === "$not") {
      where.NOT = translateWhere(value);
      continue;
    }
    if (key === "NOT") {
      where.NOT = translateWhere(value);
      continue;
    }

    if (key.includes(".")) {
      jsonClauses.push(jsonPathFilter(key, value));
      continue;
    }

    const field = mapKey(key);

    // Mongo's `{ $in: [null, ""] }` is a very common "unset or blank" idiom --
    // dcc.service.js locks a donation with exactly that on receiptNumber. In
    // Mongo, null inside $in also matches a MISSING field; in Postgres the
    // column is simply NULL. Prisma refuses null inside `in` outright:
    //   Argument `in`: Invalid value provided. Expected ListStringFieldRefInput
    //   or Null, provided (Null, String).
    // ...which threw on every call and took DCC sync -- and with it receipt
    // numbers, receipt PDFs and WhatsApp receipts -- down completely.
    //
    // The faithful translation is an OR: null, or one of the remaining values.
    // It is collected into AND so it cannot collide with an OR the filter
    // already has from a $or block.
    if (isPlainObject(value) && Array.isArray(value.$in) && value.$in.some((v) => v === null)) {
      const rest = value.$in.filter((v) => v !== null && v !== undefined);
      const branches = [{ [field]: null }];
      if (rest.length) branches.push({ [field]: { in: rest } });
      nullableClauses.push({ OR: branches });

      // Any sibling operators on the same field still apply.
      const siblings = { ...value };
      delete siblings.$in;
      if (Object.keys(siblings).length) where[field] = translateValue(siblings);
      continue;
    }

    // The mirror image: `{ $nin: [null, ""] }` means "neither null nor one of
    // these", which is an AND of two conditions rather than one `notIn`.
    if (isPlainObject(value) && Array.isArray(value.$nin) && value.$nin.some((v) => v === null)) {
      const rest = value.$nin.filter((v) => v !== null && v !== undefined);
      const conditions = [{ [field]: { not: null } }];
      if (rest.length) conditions.push({ [field]: { notIn: rest } });
      nullableClauses.push(...conditions);

      const siblings = { ...value };
      delete siblings.$nin;
      if (Object.keys(siblings).length) where[field] = translateValue(siblings);
      continue;
    }

    where[field] = translateValue(value);
  }

  if (nullableClauses.length) {
    where.AND = where.AND ? [].concat(where.AND, nullableClauses) : nullableClauses;
  }

  if (jsonClauses.length) {
    // A lone `{ root: { path, ... } }` fragment can sit at the top level next to
    // the other conditions (Prisma ANDs them implicitly), which reads far
    // closer to the Mongo filter it replaced. Anything else has to be nested.
    const only = jsonClauses.length === 1 ? Object.keys(jsonClauses[0]) : [];
    const isSimple =
      jsonClauses.length === 1 && only.length === 1 && !["OR", "AND", "NOT"].includes(only[0]);

    if (isSimple) {
      Object.assign(where, jsonClauses[0]);
    } else {
      where.AND = where.AND ? [where.AND, ...jsonClauses] : jsonClauses;
    }
  }

  return where;
}

/**
 * Translate a Mongo update document into a Prisma `data` payload.
 */
function translateUpdate(update) {
  if (!update || typeof update !== "object") return {};

  const hasOperators = Object.keys(update).some((k) => k.startsWith("$"));
  if (!hasOperators) {
    // A plain object means "set these fields to these values".
    const data = {};
    for (const [k, v] of Object.entries(update)) data[mapKey(k)] = v;
    return data;
  }

  const data = {};
  for (const [op, payload] of Object.entries(update)) {
    switch (op) {
      case "$set":
        for (const [k, v] of Object.entries(payload)) data[mapKey(k)] = v;
        break;
      case "$inc":
        for (const [k, v] of Object.entries(payload)) {
          data[mapKey(k)] = { increment: v };
        }
        break;
      case "$unset":
        for (const k of Object.keys(payload)) data[mapKey(k)] = null;
        break;
      default:
        throw new Error(
          `[mongoCompat] update operator "${op}" is not supported. ` +
            `Add it to translateUpdate() deliberately rather than letting it ` +
            `silently do the wrong thing.`
        );
    }
  }
  return data;
}

/**
 * Translate a Mongoose sort spec into a Prisma orderBy array.
 * Accepts `{ date: -1 }`, `"date"`, `"-date"`, or `"date -amount"`.
 */
function translateSort(sort) {
  if (!sort) return undefined;
  const pairs = [];

  const addPair = (field, dir) => {
    pairs.push({ [mapKey(field)]: dir === -1 || dir === "desc" || dir === "descending" ? "desc" : "asc" });
  };

  if (typeof sort === "string") {
    for (const token of sort.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) addPair(token.slice(1), -1);
      else if (token.startsWith("+")) addPair(token.slice(1), 1);
      else addPair(token, 1);
    }
  } else if (Array.isArray(sort)) {
    for (const entry of sort) {
      if (typeof entry === "string") {
        if (entry.startsWith("-")) addPair(entry.slice(1), -1);
        else addPair(entry, 1);
      } else {
        for (const [field, dir] of Object.entries(entry)) addPair(field, dir);
      }
    }
  } else {
    for (const [field, dir] of Object.entries(sort)) addPair(field, dir);
  }

  return pairs.length ? pairs : undefined;
}

// Prisma expects `omit` (and `select`) as { field: true }, never as an array.
// Returns undefined for an empty list, because Prisma rejects an empty `omit`.
function asFieldMap(fields) {
  if (!fields || !fields.length) return undefined;
  const map = {};
  for (const f of fields) map[f] = true;
  return map;
}

/**
 * Translate a Mongoose projection into Prisma `select` or `omit`.
 * Accepts `"a b -c"`, `"-c"`, `{ a: 1, b: 0 }` or `{ a: true }`.
 */
function translateProjection(projection) {
  if (projection === undefined || projection === null) return {};
  if (projection === "-") return {};

  if (typeof projection === "string") {
    if (projection.trim() === "-") return {};
    const include = [];
    const exclude = [];
    for (const token of projection.trim().split(/\s+/).filter(Boolean)) {
      if (token.startsWith("-")) exclude.push(mapKey(token.slice(1)));
      else include.push(mapKey(token));
    }
    if (exclude.length && !include.length) {
      // Pure exclusion -> Prisma `omit`. Note the SHAPE: Prisma's `omit` is a
      // map of field -> true, NOT an array of field names. Handing it an array
      // makes Prisma read the array indices as field names and every query
      // dies with `Unknown field \`0\` on model X` -- which is what took out
      // /users, /users/profile, /blogs and /hero-banners.
      return { __omit: asFieldMap(exclude) };
    }
    const select = {};
    for (const f of include) select[f] = true;
    return { __select: select };
  }

  if (isPlainObject(projection)) {
    const include = [];
    const exclude = [];
    for (const [field, flag] of Object.entries(projection)) {
      if (flag === 0 || flag === false) exclude.push(mapKey(field));
      else include.push(mapKey(field));
    }
    if (exclude.length && !include.length) return { __omit: asFieldMap(exclude) };
    const select = {};
    for (const f of include) select[f] = true;
    return { __select: select };
  }

  return {};
}

// ── chainable query ────────────────────────────────────────────────────────

/**
 * Mongoose presented every document with an `_id` (an ObjectId) plus
 * `.save()` and `.toObject()`. Prisma returns bare rows keyed on `id`.
 *
 * Re-adding those three things in one place is much safer than editing the 69
 * `doc._id` reads, the 4 `.save()` calls and the 2 `.toObject()` calls
 * individually -- and the alias has to be *enumerable* because the Next.js
 * client reads `_id` out of these same JSON responses (`hero-banners`,
 * `blogs`, `devotees`), which Mongoose's own toJSON() also included.
 *
 * `_id` is a plain string here rather than an ObjectId. Nothing in the server
 * calls toHexString()/isValid()/new ObjectId(), and the values only ever round
 * trip back into a filter, where mapKey() renames `_id` to `id` anyway.
 */
const DECORATED = Symbol.for("mongoCompat.decorated");

/**
 * Mongoose's `populate('createdBy')` overwrote the `createdBy` id with the
 * joined document, so `festival.createdBy` was an object, not a string. Prisma
 * returns the relation under its own name alongside the scalar, so the value is
 * copied back onto the Mongoose name and the alias is dropped. Without this the
 * client would silently start receiving an id where it expects a user.
 */
function applyMoves(rows, moves) {
  const list = Array.isArray(rows) ? rows : [rows];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    for (const { from, to } of moves) {
      if (!(from in row)) continue;
      const value = row[from];
      // A null relation must not clobber the id Mongoose would have left there.
      row[to] = value === null || value === undefined ? row[to] : value;
      delete row[from];
    }
  }
  return rows;
}

// Mongoose's mutating finders (findOneAndUpdate, findByIdAndUpdate,
// findByIdAndDelete, ...) return a Query, not a bare promise, so call sites
// legitimately chain `.lean()` onto them -- donationPage.update does exactly
// that. Returning a plain promise made that a TypeError
// ("...findOneAndUpdate(...).lean is not a function") and 500'd the endpoint.
// These modifiers are all no-ops here (Prisma already returns plain objects
// and the projection was applied by the write itself), so they just return
// the same thenable.
function asQueryLike(promise) {
  const passthrough = () => wrapped;
  const wrapped = {
    then: (onOk, onErr) => promise.then(onOk, onErr),
    catch: (onErr) => promise.catch(onErr),
    finally: (fn) => promise.finally(fn),
    lean: passthrough,
    exec: () => promise,
  };
  return wrapped;
}

function decorate(row, delegate) {
  if (row === null || row === undefined) return row;
  if (Array.isArray(row)) return row.map((r) => decorate(r, delegate));
  if (typeof row !== "object" || row instanceof Date || row[DECORATED]) return row;

  if (row.id !== undefined && row._id === undefined) {
    Object.defineProperty(row, "_id", {
      value: row.id,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  // Non-enumerable so they vanish from Object.keys/spread/JSON.stringify.
  Object.defineProperty(row, "toObject", {
    value: function toObject() {
      const out = { ...this };
      delete out.toObject;
      delete out.save;
      return out;
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(row, "save", {
    value: async function save() {
      if (!this.id) {
        throw new Error(
          `[mongoCompat] save() on a document without an id -- use create() instead.`
        );
      }
      // Mongoose sent only the modified paths; sending the whole row is
      // equivalent here and is only safe because every call site that saves
      // fetched the document without a projection.
      const fields = { ...this };
      delete fields.toObject;
      delete fields.save;
      delete fields._id;
      delete fields.id;
      return decorate(await delegate.update({ where: { id: this.id }, data: fields }), delegate);
    },
    enumerable: false,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(row, DECORATED, { value: true, enumerable: false });
  return row;
}

/**
 * Mongoose populated the *foreign key field* and replaced its value with the
 * joined document. Prisma cannot share one name for both the scalar and the
 * relation, so the schema names them apart (`createdBy` + `creator`). These
 * aliases map the Mongoose spelling back onto the Prisma relation, and the
 * result is then moved onto the Mongoose name so the JSON the client already
 * consumes is byte-for-byte what it was under Mongoose.
 */
// Keyed by the PRISMA DELEGATE NAME -- the string handed to createModel(),
// which is camelCase ("blog", "festivalDonation"), not the PascalCase model
// name. This map used to be keyed PascalCase, so every lookup missed, no
// alias was ever applied, and .populate("createdBy") asked Prisma to include
// a scalar column as if it were a relation. That is what 500'd
// /festival-donations, /festival-donations/:slug and /blogs/deletion-requests.
const RELATION_ALIASES = {
  blog: { deletionRequestedBy: "deletionRequester" },
  festivalDonation: { createdBy: "creator", eventId: "event" },
  campaigner: { referredByDevotee: "referrer" },
};

// Accept the delegate name in either casing. Production passes the camelCase
// Prisma delegate name ("festivalDonation"); the compat tests construct
// queries with the PascalCase model name ("FestivalDonation"). Looking up both
// means a caller can never silently get no aliases at all, which is the
// failure mode that 500'd /festival-donations and /blogs/deletion-requests.
function relationAliasesFor(modelName) {
  if (!modelName) return {};
  const lower = modelName.charAt(0).toLowerCase() + modelName.slice(1);
  const upper = modelName.charAt(0).toUpperCase() + modelName.slice(1);
  return RELATION_ALIASES[modelName] || RELATION_ALIASES[lower] || RELATION_ALIASES[upper] || {};
}

/** "name email" | "a, b" | "a b -c" -> Prisma select object */
function parsePopulateSelect(spec) {
  if (spec === undefined || spec === null) return true;
  const fields = String(spec)
    .split(/[\s,]+/)
    .filter(Boolean);
  const excluded = fields.filter((f) => f.startsWith("-")).map((f) => mapKey(f.slice(1)));
  const included = fields.filter((f) => !f.startsWith("-")).map(mapKey);

  if (included.length && !excluded.length) {
    // As above: Mongoose's populate("x", "name email") still hands back the
    // populated document's _id, so keep it.
    const select = { id: true };
    for (const f of included) select[f] = true;
    return { select };
  }
  if (!included.length && excluded.length) {
    return { omit: asFieldMap(excluded) };
  }
  throw new Error(
    `[mongoCompat] Cannot mix inclusions and exclusions in populate("${spec}").`
  );
}

/**
 * A thenable query builder. Mongoose queries are awaitable AND chainable
 * (`Model.find(f).sort(s).skip(n).lean()`), so this has to be both -- a bare
 * Promise cannot be, which is why this class exists.
 */
class Query {
  constructor(modelName, delegate) {
    this.modelName = modelName;
    this.delegate = delegate;
    this._where = {};
    this._orderBy = undefined;
    this._skip = undefined;
    this._take = undefined;
    this._projection = {};
    this._include = undefined;
    this._moves = [];
    this._single = false;
  }

  where(clause) {
    this._where = translateWhere(clause);
    return this;
  }

  sort(sort) {
    this._orderBy = translateSort(sort);
    return this;
  }

  skip(n) {
    this._skip = n;
    return this;
  }

  limit(n) {
    this._take = n;
    return this;
  }

  select(projection) {
    this._projection = translateProjection(projection);
    return this;
  }

  // Prisma already returns plain objects, so Mongoose's .lean() is a no-op
  // here. Kept so existing call sites do not need editing.
  lean() {
    return this;
  }

  // Populates become a Prisma `include`. The joined document is then moved back
  // onto the Mongoose field name (see RELATION_ALIASES) so that callers and the
  // client see `createdBy` as an object, exactly as Mongoose's populate left it.
  populate(path, select) {
    const aliases = relationAliasesFor(this.modelName);
    const target = aliases[path] || path;
    if (!this._include) this._include = {};
    this._include[target] = parsePopulateSelect(select);
    this._moves.push({ from: target, to: path });
    return this;
  }

  async _args() {
    const args = { where: this._where };
    if (this._orderBy) args.orderBy = this._orderBy;
    if (this._skip !== undefined) args.skip = this._skip;
    if (this._take !== undefined) args.take = this._take;
    if (this._projection.__omit) args.omit = this._projection.__omit;
    else if (this._projection.__select) {
      // Mongoose always returns _id unless it is explicitly excluded, and
      // callers rely on that (the admin lists need an id to act on the row).
      // A bare Prisma `select` would drop it silently.
      args.select = { id: true, ...this._projection.__select };
    }
    // Prisma REJECTS `select` and `include` together -- "Please either use
    // `include` or `select`, but not both at the same time". A relation can
    // however be requested from inside `select`, which is the same result, so
    // fold the populates in when a projection is active. Only when there is no
    // projection is a top-level `include` correct.
    if (this._include) {
      if (args.select) args.select = { ...args.select, ...this._include };
      else args.include = this._include;
    }
    return args;
  }

  async _run() {
    const args = await this._args();
    const rows = decorate(await this.delegate.findMany(args), this.delegate);
    if (this._moves.length) applyMoves(rows, this._moves);
    // findOne resolves to the first row (or null) but stays chainable, because
    // call sites do `findOne({...}).sort({createdAt:-1}).select("title")`.
    return this._single ? (rows[0] === undefined ? null : rows[0]) : rows;
  }

  // `await query` and `query.then()` both land here.
  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._run().catch(onRejected);
  }

  finally(fn) {
    return this._run().finally(fn);
  }
}

// ── document (for `new Model(data).save()`) ────────────────────────────────

class Document {
  constructor(modelName, delegate, data) {
    this.modelName = modelName;
    this._delegate = delegate;
    this._data = { ...(data || {}) };
  }

  // Reading/writing a field goes to the backing payload.
  get(key) {
    return this._data[key];
  }

  set(key, value) {
    this._data[key] = value;
    return this;
  }

  toObject() {
    return { ...this._data };
  }

  toJSON() {
    return { ...this._data };
  }

  async save() {
    const id = this._data.id;
    const data = { ...this._data };
    delete data.id;

    if (id) {
      this._data = await this._delegate.update({ where: { id }, data });
    } else {
      this._data = await this._delegate.create({ data });
    }
    return this;
  }
}

// ── model factory ──────────────────────────────────────────────────────────

/**
 * Wrap one Prisma model delegate in the Mongoose-shaped API the controllers
 * call. `prismaName` is the Prisma client key (e.g. "donation").
 */
function createModel(prismaName) {
  const delegate = prisma[prismaName];

  if (!delegate) {
    throw new Error(
      `[mongoCompat] prisma.${prismaName} does not exist. Check the model ` +
        `name in prisma/schema.prisma and that the client has been ` +
        `regenerated (npx prisma generate).`
    );
  }

  const model = {
    // Building a query without awaiting it.
    find(filter, projection) {
      const q = new Query(prismaName, delegate);
      if (filter) q.where(filter);
      if (projection) q.select(projection);
      return q;
    },

    findOne(filter, projection) {
      const q = new Query(prismaName, delegate);
      q._single = true;
      if (filter) q.where(filter);
      if (projection) q.select(projection);
      return q;
    },

    findById(id, projection) {
      const q = new Query(prismaName, delegate);
      q.where({ id });
      if (projection) q.select(projection);
      // findById resolves to ONE document or null, exactly like findOne.
      // Without this flag the query resolved to an ARRAY at all ~30 call
      // sites: `donation.status` / `event.title` / `existing.save()` were
      // silently undefined, GET /events/:id answered 200 with an array
      // instead of the object the client expects, and the payment-completion
      // and DCC-sync services read their fields off an array.
      q._single = true;
      return q;
    },

    // Mongoose returns the PRE-update document unless { new: true } is passed
    // -- omitting `new` is NOT the same as `new: true`.
    //
    // Several call sites depend on the *filter* being the guard rather than
    // just a lookup: paymentCompletion marks a donation completed only if it
    // still is not, and dcc.service takes a lock only if dccSyncStatus is not
    // already "syncing". Both then treat a null result as "someone else won".
    // Reading the id first and then writing by id alone would let two workers
    // both win, so the original filter is re-applied inside the UPDATE. In
    // Postgres READ COMMITTED a blocked UPDATE re-checks its WHERE against the
    // newly committed row, so the loser gets count === 0 and we return null --
    // which is exactly findAndModify's atomic behaviour.
    async findByIdAndUpdate(id, update, options = {}) {
      const data = translateUpdate(update);
      const returnNew = options.new === true || options.returnDocument === "after";
      if (returnNew) return decorate(await delegate.update({ where: { id }, data }), delegate);

      return prisma.$transaction(async (tx) => {
        const before = await tx[prismaName].findUnique({ where: { id } });
        if (!before) return null;
        await tx[prismaName].update({ where: { id }, data });
        return decorate(before, delegate);
      });
    },

    async findOneAndUpdate(filter, update, options = {}) {
      const where = translateWhere(filter);
      const data = translateUpdate(update);
      const returnNew = options.new === true || options.returnDocument === "after";

      return prisma.$transaction(async (tx) => {
        const existing = await tx[prismaName].findFirst({ where, select: { id: true } });
        if (!existing) {
          if (!options.upsert) return null;
          // Upsert. The filter's own top-level equalities become the seed
          // values, so `{ key: "main" }` inserts a row with key "main".
          const seed = {};
          for (const [key, value] of Object.entries(filter || {})) {
            if (key.startsWith("$")) continue;
            if (value === null || typeof value !== "object") seed[mapKey(key)] = value;
          }
          return decorate(
            await tx[prismaName].create({ data: { ...seed, ...data, id: undefined } }),
            delegate
          );
        }

        // Re-assert the caller's filter alongside the id so the guard is
        // applied by the UPDATE itself, not merely by the lookup above.
        // For the pre-update return shape the old row has to be captured
        // before the write, which is safe because this is all one transaction.
        const before = returnNew ? null : await tx[prismaName].findUnique({ where: { id: existing.id } });
        const guarded = await tx[prismaName].updateMany({
          where: { AND: [{ id: existing.id }, where] },
          data,
        });
        if (guarded.count === 0) return null; // lost the race; caller sees null

        if (returnNew) {
          return decorate(await tx[prismaName].findUnique({ where: { id: existing.id } }), delegate);
        }
        return decorate(before, delegate);
      });
    },

    async findByIdAndDelete(id) {
      return decorate(await delegate.delete({ where: { id } }), delegate);
    },

    async deleteOne(filter) {
      const where = translateWhere(filter);
      const existing = await delegate.findFirst({ where, select: { id: true } });
      if (!existing) return { deletedCount: 0 };
      await delegate.delete({ where: { id: existing.id } });
      return { deletedCount: 1 };
    },

    async updateOne(filter, update) {
      const where = translateWhere(filter);
      const data = translateUpdate(update);
      const existing = await delegate.findFirst({ where, select: { id: true } });
      if (!existing) return { matchedCount: 0, modifiedCount: 0 };
      await delegate.update({ where: { id: existing.id }, data });
      return { matchedCount: 1, modifiedCount: 1 };
    },

    async updateMany(filter, update) {
      const result = await delegate.updateMany({
        where: translateWhere(filter),
        data: translateUpdate(update),
      });
      return { modifiedCount: result.count };
    },

    async deleteMany(filter) {
      const result = await delegate.deleteMany({ where: translateWhere(filter) });
      return { deletedCount: result.count };
    },

    async countDocuments(filter) {
      return delegate.count({ where: translateWhere(filter) });
    },

    async estimatedDocumentCount() {
      return delegate.count();
    },

    async exists(filter) {
      const found = await delegate.findFirst({
        where: translateWhere(filter),
        select: { id: true },
      });
      return found ? { _id: found.id } : null;
    },

    async distinct(field, filter) {
      const rows = await delegate.findMany({
        where: translateWhere(filter),
        select: { [mapKey(field)]: true },
        distinct: [mapKey(field)],
      });
      return rows.map((r) => r[mapKey(field)]);
    },

    async create(data) {
      return decorate(await delegate.create({ data: { ...data, id: undefined } }), delegate);
    },

    async insertMany(rows) {
      const created = [];
      for (const row of rows) {
        created.push(decorate(await delegate.create({ data: { ...row, id: undefined } }), delegate));
      }
      return created;
    },
  };

  // Mongoose's mutating finders return a Query, so call sites chain `.lean()`
  // onto them (donationPage.update does). These return bare promises, so wrap
  // them once, here, rather than editing each one.
  for (const name of [
    "findByIdAndUpdate",
    "findOneAndUpdate",
    "findByIdAndDelete",
    "findOneAndDelete",
  ]) {
    const impl = model[name];
    if (typeof impl !== "function") continue;
    model[name] = (...args) => asQueryLike(Promise.resolve(impl.apply(model, args)));
  }

  // `new Model(data)` builds a document that can be saved.
  const Model = new Proxy(model, {
    apply: () => {
      throw new Error(`[mongoCompat] ${prismaName} is not callable.`);
    },
    construct: (_target, args) => new Document(prismaName, delegate, args[0]),
    get: (_target, prop) => {
      if (prop in model) return model[prop];
      return undefined;
    },
  });

  return Model;
}

module.exports = {
  prisma,
  createModel,
  translateWhere,
  translateUpdate,
  translateSort,
  translateProjection,
  parsePopulateSelect,
  applyMoves,
  decorate,
  relationAliasesFor,
  asQueryLike,
  Query,
  Document,
};

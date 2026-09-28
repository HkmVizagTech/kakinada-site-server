const express = require("express");
const axios = require("axios");

const blogProxyRouter = express.Router();

// Vizag server base URL — set via env var
const VIZAG_API_URL =
  (process.env.VIZAG_API_URL || "https://hkmsite20-server-production.up.railway.app").replace(/\/+$/, "");

// ── Fetch-through cache ────────────────────────────────────────────────────
//
// Every blog page on this site is served from Vizag's server. That made Vizag
// a hard single point of failure: if that one Railway service is down or slow,
// the blog section of BOTH sister sites goes blank at the same moment, with a
// 502 on every request and nothing to fall back on.
//
// Blog posts change a few times a week, so serving a copy that is a few
// minutes — or in an outage, a few hours — old is very obviously better than
// serving nothing. This cache does three things:
//
//   1. FRESH    a hit inside the TTL is served without touching Vizag at all,
//               which also takes almost all of this site's load off it.
//   2. STALE    if the upstream request fails and there is ANY cached copy,
//               however old, that copy is served instead of a 502. The
//               response carries X-Blog-Cache: stale and its age, so the
//               condition is visible rather than silent.
//   3. SINGLE-FLIGHT  concurrent misses for the same key share one upstream
//               request, so an expiring cache cannot stampede Vizag.
//
// It is deliberately in-process rather than Redis: one container, no new
// dependency, and a cold start simply behaves the way it did before.
const CACHE_TTL_MS = Number(process.env.BLOG_CACHE_TTL_SECONDS || 300) * 1000;
// How long a stale copy may still be served during an outage. Generous on
// purpose — the alternative is an empty blog section.
const CACHE_STALE_MS = Number(process.env.BLOG_CACHE_STALE_HOURS || 24) * 60 * 60 * 1000;
// Bounded so a crawler hitting thousands of slugs cannot grow this forever.
const CACHE_MAX_ENTRIES = Number(process.env.BLOG_CACHE_MAX_ENTRIES || 300);

const cache = new Map(); // key -> { data, at }
const inFlight = new Map(); // key -> Promise

function cacheSet(key, data) {
  // Map preserves insertion order, so the oldest key is the first one out.
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, { data, at: Date.now() });
}

/**
 * Fetches `path` from the Vizag server through the cache and writes the
 * response. `label` only ever appears in logs.
 *
 * A 404 from upstream is forwarded as a 404: that means "no such post", which
 * is a real answer, not an outage, and must not be masked by a stale copy.
 */
async function proxy(req, res, path, label, notFoundMessage) {
  const key = path;
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (hit && age < CACHE_TTL_MS) {
    res.set("X-Blog-Cache", "hit");
    return res.status(200).json(hit.data);
  }

  try {
    let promise = inFlight.get(key);
    if (!promise) {
      promise = axios
        .get(`${VIZAG_API_URL}${path}`, { timeout: 10000, headers: { Accept: "application/json" } })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
    }
    const response = await promise;
    cacheSet(key, response.data);
    res.set("X-Blog-Cache", "miss");
    return res.status(200).json(response.data);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({ message: notFoundMessage || "Not found" });
    }

    // Upstream is unreachable or erroring. Serve whatever we last saw.
    if (hit && age < CACHE_STALE_MS) {
      console.warn(
        `Blog proxy ${label} failed (${err.message}) — serving a cached copy ${Math.round(age / 1000)}s old`
      );
      res.set("X-Blog-Cache", "stale");
      res.set("X-Blog-Cache-Age", String(Math.round(age / 1000)));
      return res.status(200).json(hit.data);
    }

    console.error(`Blog proxy ${label} error:`, err.message);
    return res.status(502).json({ message: "Unable to fetch blog data from source" });
  }
}

// PUBLIC — proxy the Vizag blog landing data
// Returns recents, devotional, categories, byCategory, popular, recent
blogProxyRouter.get("/landing", (req, res) => proxy(req, res, "/blogs/landing", "landing"));

// PUBLIC — proxy blog categories
blogProxyRouter.get("/categories", (req, res) => proxy(req, res, "/blogs/categories", "categories"));

// PUBLIC — proxy blog list with query params
blogProxyRouter.get("/", (req, res) => {
  const params = new URLSearchParams();
  // Allowlisted and rebuilt in a fixed order, so the cache key is stable
  // regardless of the order the client happened to send them in.
  for (const name of ["limit", "page", "category", "search", "sort"]) {
    if (req.query[name]) params.set(name, req.query[name]);
  }
  const qs = params.toString();
  return proxy(req, res, `/blogs${qs ? `?${qs}` : ""}`, "list");
});

// PUBLIC — proxy related blogs
// Declared BEFORE /:slug so "related" is not swallowed as a slug.
blogProxyRouter.get("/:id/related", (req, res) =>
  proxy(req, res, `/blogs/${encodeURIComponent(req.params.id)}/related`, "related")
);

// PUBLIC — proxy a single blog by slug
blogProxyRouter.get("/:slug", (req, res) =>
  proxy(req, res, `/blogs/${encodeURIComponent(req.params.slug)}`, "single", "Blog not found")
);

module.exports = { blogProxyRouter, __cache: cache };

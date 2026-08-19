const express = require("express");
const axios = require("axios");

const blogProxyRouter = express.Router();

// Vizag server base URL — set via env var
const VIZAG_API_URL =
  (process.env.VIZAG_API_URL || "https://hkmsite2-0-server.vercel.app").replace(/\/+$/, "");

// PUBLIC — proxy the Vizag blog landing data
// Returns recents, devotional, categories, byCategory, popular, recent
blogProxyRouter.get("/landing", async (req, res) => {
  try {
    const response = await axios.get(`${VIZAG_API_URL}/blogs/landing`, {
      timeout: 10000,
      headers: { Accept: "application/json" },
    });
    res.status(200).json(response.data);
  } catch (err) {
    console.error("Blog proxy landing error:", err.message);
    res.status(502).json({ message: "Unable to fetch blog data from source" });
  }
});

// PUBLIC — proxy blog categories
blogProxyRouter.get("/categories", async (req, res) => {
  try {
    const response = await axios.get(`${VIZAG_API_URL}/blogs/categories`, {
      timeout: 10000,
      headers: { Accept: "application/json" },
    });
    res.status(200).json(response.data);
  } catch (err) {
    console.error("Blog proxy categories error:", err.message);
    res.status(502).json({ message: "Unable to fetch categories from source" });
  }
});

// PUBLIC — proxy blog list with query params
blogProxyRouter.get("/", async (req, res) => {
  try {
    const params = new URLSearchParams();
    if (req.query.limit) params.set("limit", req.query.limit);
    if (req.query.page) params.set("page", req.query.page);
    if (req.query.category) params.set("category", req.query.category);
    if (req.query.search) params.set("search", req.query.search);
    if (req.query.sort) params.set("sort", req.query.sort);

    const response = await axios.get(`${VIZAG_API_URL}/blogs?${params.toString()}`, {
      timeout: 10000,
      headers: { Accept: "application/json" },
    });
    res.status(200).json(response.data);
  } catch (err) {
    console.error("Blog proxy list error:", err.message);
    res.status(502).json({ message: "Unable to fetch blogs from source" });
  }
});

// PUBLIC — proxy a single blog by slug
blogProxyRouter.get("/:slug", async (req, res) => {
  try {
    const response = await axios.get(`${VIZAG_API_URL}/blogs/${req.params.slug}`, {
      timeout: 10000,
      headers: { Accept: "application/json" },
    });
    res.status(200).json(response.data);
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ message: "Blog not found" });
    }
    console.error("Blog proxy single error:", err.message);
    res.status(502).json({ message: "Unable to fetch blog from source" });
  }
});

// PUBLIC — proxy related blogs
blogProxyRouter.get("/:id/related", async (req, res) => {
  try {
    const response = await axios.get(`${VIZAG_API_URL}/blogs/${req.params.id}/related`, {
      timeout: 10000,
      headers: { Accept: "application/json" },
    });
    res.status(200).json(response.data);
  } catch (err) {
    console.error("Blog proxy related error:", err.message);
    res.status(502).json({ message: "Unable to fetch related blogs from source" });
  }
});

module.exports = { blogProxyRouter };

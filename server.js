// server.js
// Hardened Node/Express proxy for OpenRouter with timeout, retry, and connection-safety headers.
// Paste this file exactly and redeploy to Render.

const express = require("express");
const http = require("http");
const fetch = global.fetch || require("node-fetch"); // Render/Node18+ should have global fetch
const AbortController = global.AbortController || require("abort-controller");

const app = express();

// Security: disable X-Powered-By
app.disable("x-powered-by");

// Increase JSON/body size to handle base64 images if needed (adjust if necessary).
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// CORS - allow your frontend origin(s). Replace or narrow down before production.
const ALLOWED_ORIGINS = [
  "https://fitnessmate.netlify.app",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*"); // fallback for debugging
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");

  // Ask the proxy/client to close the connection after this response (reduces reuse issues)
  res.setHeader("Connection", "close");
  res.setHeader("Keep-Alive", "timeout=5, max=0");

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// Upstream target
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Utility: fetch with timeout and a single retry for transient failures
async function fetchWithTimeoutAndRetry(url, options = {}, timeoutMs = 60000, maxRetries = 1) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const merged = { ...options, signal: controller.signal };
      const start = Date.now();
      const resp = await fetch(url, merged);
      clearTimeout(id);

      // if 5xx, treat as transient and retry
      if (resp.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`Upstream ${resp.status} - will retry (attempt ${attempt + 1})`);
        console.warn(new Date().toISOString(), lastErr.message);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); // small backoff
        continue;
      }
      return resp;
    } catch (err) {
      clearTimeout(id);
      lastErr = err;
      // if aborted or network error, retry if we still have attempts
      console.warn(new Date().toISOString(), "Fetch attempt failed:", err && err.message);
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Main route used by your frontend: POST to /api/myapi
app.post("/api/myapi", async (req, res) => {
  const t0 = Date.now();
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.error("OPENROUTER_API_KEY missing");
      return res.status(500).json({ error: "Server misconfigured: OPENROUTER_API_KEY missing" });
    }

    const body = req.body || {};

    // Normalize payload
    let payload;
    if (body.messages || body.model) {
      payload = body;
    } else {
      payload = {
        model: body.model || "google/gemini-2.5-flash",
        messages: [{ role: "user", content: String(body.prompt || "Hello") }],
        max_tokens: body.max_tokens || 300,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.2
      };
      if (body.image_url) payload.image_url = body.image_url;
      if (body.image_base64) payload.image_base64 = body.image_base64;
    }

    // Proxy to OpenRouter with timeout + retry
    const upstream = await fetchWithTimeoutAndRetry(
      OPENROUTER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
          "User-Agent": "fitnessmate-proxy/1.0"
        },
        body: JSON.stringify(payload)
      },
      60000, // 60s timeout per attempt
      1 // one retry allowed
    );

    // Read full upstream response text
    const upstreamText = await upstream.text().catch(() => "");
    console.log(new Date().toISOString(), "Upstream status:", upstream.status, "elapsed:", Date.now() - t0, "ms");
    console.log("Upstream body preview:", upstreamText.slice(0, 1000));

    if (!upstream.ok) {
      // Forward upstream status and raw body to client for debugging
      const replyText = upstreamText || `Upstream returned status ${upstream.status}`;
      // Ensure CORS headers are present on error too
      res.status(upstream.status).type("text/plain").send(replyText);
      return;
    }

    // Parse JSON if possible
    let data;
    try {
      data = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (e) {
      data = { raw: upstreamText };
    }

    // Final response (with connection close header already set by middleware)
    return res.status(200).json(data);
  } catch (err) {
    console.error(new Date().toISOString(), "Server error:", err && err.stack ? err.stack : err);
    return res.status(502).json({ error: String(err) });
  }
});

// Health / quick check
app.get("/_health", (req, res) => res.status(200).send("ok"));

// Explicitly create http server (helps avoid any accidental http2 usage)
const port = process.env.PORT || 5501;
const server = http.createServer(app);
server.listen(port, () => console.log(`Listening on ${port}`));

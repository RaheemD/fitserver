// server.js
// Full replacement - paste this file exactly to Render and redeploy.

const express = require("express");
const http = require("http");
const process = require("process");

// fetch + AbortController polyfills if needed
let fetchImpl = global.fetch;
let AbortControllerImpl = global.AbortController;
try {
  if (!fetchImpl) fetchImpl = require("node-fetch");
} catch (e) {
  // node-fetch may not be installed; Render / Node18+ normally has global fetch
}
try {
  if (!AbortControllerImpl) AbortControllerImpl = require("abort-controller");
} catch (e) {}

const app = express();

// Security
app.disable("x-powered-by");

// Body size
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// CORS - limited to your frontend origin(s). Replace or add origins if needed.
const ALLOWED_ORIGINS = [
  "https://fitnessmate.netlify.app",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  } else {
    // during debugging allow any origin (change to strict in prod)
    res.setHeader("Access-Control-Allow-Origin", "*");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");

  // Ask proxies/clients to close connections after response (reduces reuse issues)
  res.setHeader("Connection", "close");
  res.setHeader("Keep-Alive", "timeout=5, max=0");

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// Upstream target
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Helper: fetch with timeout + 1 retry for transient failures
async function fetchWithTimeoutAndRetry(url, options = {}, timeoutMs = 60000, maxRetries = 1) {
  const AbortCtr = AbortControllerImpl || global.AbortController;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = AbortCtr ? new AbortCtr() : null;
    const signal = controller ? controller.signal : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

    try {
      const merged = { ...options, signal };
      const resp = await (fetchImpl || global.fetch)(url, merged);
      if (timer) clearTimeout(timer);

      // treat 5xx as retryable (transient)
      if (resp.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`Upstream ${resp.status} (will retry)`);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastErr = err;
      // if retry remains, backoff and try again
      if (attempt < maxRetries) {
        console.warn(new Date().toISOString(), "Fetch attempt failed, will retry:", err && err.message);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

// Main proxy endpoint
app.post("/api/myapi", async (req, res) => {
  const start = Date.now();
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      console.error("OPENROUTER_API_KEY missing");
      return res.status(500).json({ error: "Server misconfigured: OPENROUTER_API_KEY missing" });
    }

    const body = req.body || {};
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

    // Proxy call with timeout + retry
    const upstream = await fetchWithTimeoutAndRetry(
      OPENROUTER_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "User-Agent": "fitnessmate-proxy/1.0"
        },
        body: JSON.stringify(payload)
      },
      60000,
      1
    );

    const upstreamText = await upstream.text().catch(() => "");
    const elapsed = Date.now() - start;

    // Log a preview to help debugging
    console.log(new Date().toISOString(), "Upstream status:", upstream.status, "elapsed_ms:", elapsed);
    console.log("Upstream preview:", upstreamText ? upstreamText.slice(0, 2000) : "(empty)");

    const trimmed = (upstreamText || "").trim();
    // If upstream returned HTML/error page, convert to JSON error for the client
    if (trimmed && trimmed[0] === "<") {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON (HTML) — see upstreamPreview",
        upstreamStatus: upstream.status,
        upstreamPreview: upstreamText.slice(0, 2000)
      });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        ok: false,
        error: "Upstream returned error",
        upstreamStatus: upstream.status,
        upstreamBody: upstreamText
      });
    }

    // Try parse as JSON; if parse fails, return raw under "raw"
    try {
      const data = upstreamText ? JSON.parse(upstreamText) : null;
      return res.status(200).json(data);
    } catch (e) {
      return res.status(200).json({ ok: true, raw: upstreamText });
    }
  } catch (err) {
    console.error(new Date().toISOString(), "Server error in /api/myapi:", err && err.stack ? err.stack : err);
    return res.status(502).json({ error: String(err) });
  }
});

// Health check
app.get("/_health", (req, res) => res.status(200).send("ok"));

// Create explicit HTTP server (keeps behavior consistent)
const port = process.env.PORT || 5501;
const server = http.createServer(app);
server.listen(port, () => console.log(`Listening on ${port}`));

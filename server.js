// server.js
// Minimal full replacement - paste exactly and redeploy

const express = require("express");
const http = require("http");

// Use global.fetch if present (Node18+). If not present, try to require node-fetch.
// If node-fetch is not available, fetch will be undefined and upstream calls will fail (but Render usually has global fetch).
let fetchImpl = global.fetch;
try {
  if (!fetchImpl) {
    // old node-fetch usage (if installed in your project)
    // eslint-disable-next-line global-require
    fetchImpl = require("node-fetch");
  }
} catch (e) {
  // ignore; we'll rely on global.fetch
}

const app = express();
app.disable("x-powered-by");

// keep high body limits for base64 images
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Simple, robust CORS middleware that echoes requested headers so preflight succeeds
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  // Echo origin if provided, otherwise allow all (debug friendly)
  res.setHeader("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Methods
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,DELETE");

  // If browser asks for certain headers in preflight, echo them back
  const requested = req.headers["access-control-request-headers"];
  if (requested && typeof requested === "string") {
    res.setHeader("Access-Control-Allow-Headers", requested);
  } else {
    // default allowed headers (include your custom header here too)
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With, x-fitmap-ignore-quota"
    );
  }

  // Expose common headers
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");

  // Quick response to preflight
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// Upstream target
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Minimal proxy handler: forwards JSON to OpenRouter and returns JSON always.
// Prevents sending HTML to clients by wrapping non-JSON upstream responses.
app.post("/api/myapi", async (req, res) => {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return res.status(500).json({ ok: false, error: "OPENROUTER_API_KEY missing" });
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

    // Use fetchImpl if available, otherwise global.fetch
    const fetchToUse = fetchImpl || global.fetch;
    if (!fetchToUse) {
      console.error("No fetch available in runtime. Install node-fetch or use Node18+.");
      return res.status(500).json({ ok: false, error: "Server misconfigured: fetch not available" });
    }

    const upstreamResp = await fetchToUse(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    });

    // Read text first because response might be HTML (error page)
    const upstreamText = await upstreamResp.text().catch(() => "");

    // Log concise preview for debugging (Render logs)
    console.log(new Date().toISOString(), "Upstream status:", upstreamResp.status);
    if (upstreamText && upstreamText.length) {
      console.log("Upstream preview:", upstreamText.slice(0, 1000));
    } else {
      console.log("Upstream preview: (empty)");
    }

    // If upstream returned HTML (starts with "<"), wrap into JSON and return 502
    const trimmed = (upstreamText || "").trim();
    if (trimmed && trimmed[0] === "<") {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON (HTML). See upstreamPreview.",
        upstreamStatus: upstreamResp.status,
        upstreamPreview: upstreamText.slice(0, 1000)
      });
    }

    // If upstream is not OK (4xx/5xx), forward status and body as JSON for easier client handling
    if (!upstreamResp.ok) {
      return res.status(upstreamResp.status).json({
        ok: false,
        error: "Upstream error",
        upstreamStatus: upstreamResp.status,
        upstreamBody: upstreamText
      });
    }

    // Try to parse JSON, if parse fails return raw under 'raw'
    try {
      const parsed = upstreamText ? JSON.parse(upstreamText) : null;
      return res.status(200).json(parsed);
    } catch (e) {
      return res.status(200).json({ ok: true, raw: upstreamText });
    }
  } catch (err) {
    console.error("Server error in /api/myapi:", err && err.stack ? err.stack : err);
    return res.status(502).json({ ok: false, error: String(err) });
  }
});

// Health check
app.get("/_health", (req, res) => res.status(200).send("ok"));

// Start server with explicit http server
const port = process.env.PORT || 5501;
const server = http.createServer(app);
server.listen(port, () => console.log(`Listening on ${port}`));

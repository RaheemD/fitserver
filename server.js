// server.js
// Full replacement: Express frontend + HTTP/2 client upstream to OpenRouter
// Paste this exactly and redeploy to Render.

const express = require("express");
const http = require("http");
const http2 = require("http2"); // used for upstream HTTP/2 client
const { URL } = require("url");

const app = express();
app.disable("x-powered-by");

// Body limits (keep high for base64 images)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// CORS: echo requested headers so preflight won't fail for custom headers
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin === "null" ? "*" : origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS,PUT,DELETE");

  const requested = req.headers["access-control-request-headers"];
  if (requested && typeof requested === "string") {
    res.setHeader("Access-Control-Allow-Headers", requested);
  } else {
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With, x-fitmap-ignore-quota"
    );
  }

  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");

  // reduce keepalive reuse problems (helps some proxies)
  res.setHeader("Connection", "close");
  res.setHeader("Keep-Alive", "timeout=5, max=0");

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// Config
const OPENROUTER_HOST = "https://openrouter.ai";
const OPENROUTER_PATH = "/api/v1/chat/completions";
const OPENROUTER_URL = `${OPENROUTER_HOST}${OPENROUTER_PATH}`;
const DEFAULT_TIMEOUT_MS = 60000; // 60s

// Helper: POST to OpenRouter using Node http2 client (returns { status, text })
async function postHttp2ToOpenRouter(key, payload, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      // Connect to host (TLS) - uses ALPN to negotiate HTTP/2
      client = http2.connect(OPENROUTER_HOST);
    } catch (err) {
      return reject(err);
    }

    client.on("error", (err) => {
      // connection-level errors
      try { client.close(); } catch (_) {}
      return reject(err);
    });

    // prepare headers
    const headers = {
      ":method": "POST",
      ":path": OPENROUTER_PATH,
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "user-agent": "fitnessmate-proxy/1.0",
    };

    const req = client.request(headers, { endStream: false });

    let status = 0;
    let chunks = "";

    // collect status from headers event
    req.on("response", (headers) => {
      if (headers && headers[":status"]) status = headers[":status"];
    });

    req.setEncoding("utf8");
    req.on("data", (chunk) => (chunks += chunk));
    req.on("end", () => {
      // close request and client
      try { req.close(); } catch (_) {}
      try { client.close(); } catch (_) {}
      resolve({ status: status || 200, text: chunks });
    });

    req.on("error", (err) => {
      try { req.close(); } catch (_) {}
      try { client.close(); } catch (_) {}
      reject(err);
    });

    // write body and end
    try {
      req.write(JSON.stringify(payload));
      req.end();
    } catch (err) {
      try { req.close(); } catch (_) {}
      try { client.close(); } catch (_) {}
      return reject(err);
    }

    // timeout enforcement
    const timer = setTimeout(() => {
      try { req.close(); } catch (_) {}
      try { client.close(); } catch (_) {}
      reject(new Error("Upstream HTTP/2 request timed out"));
    }, timeoutMs);

    // clear timer on finish
    const clearTimer = () => {
      if (timer) clearTimeout(timer);
    };
    req.on("end", clearTimer);
    req.on("error", clearTimer);
  });
}

// Main proxy endpoint
app.post("/api/myapi", async (req, res) => {
  const start = Date.now();
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
        temperature: typeof body.temperature === "number" ? body.temperature : 0.2,
      };
      if (body.image_url) payload.image_url = body.image_url;
      if (body.image_base64) payload.image_base64 = body.image_base64;
    }

    // attempt HTTP/2 POST to OpenRouter
    let upstreamResult;
    try {
      upstreamResult = await postHttp2ToOpenRouter(key, payload, DEFAULT_TIMEOUT_MS);
    } catch (err) {
      // If HTTP/2 client fails, log and return structured error (do not expose raw HTML)
      console.error(new Date().toISOString(), "HTTP/2 upstream error:", err && err.message ? err.message : err);
      return res.status(502).json({
        ok: false,
        error: "Upstream HTTP/2 request failed",
        detail: String(err && err.message ? err.message : err),
      });
    }

    const elapsed = Date.now() - start;
    const upstreamText = upstreamResult && upstreamResult.text ? upstreamResult.text : "";
    const upstreamStatus = upstreamResult && upstreamResult.status ? upstreamResult.status : 502;

    // log preview to Render logs
    console.log(new Date().toISOString(), "Upstream HTTP/2 status:", upstreamStatus, "elapsed_ms:", elapsed);
    if (upstreamText && upstreamText.length) {
      console.log("Upstream preview:", upstreamText.slice(0, 1500));
    } else {
      console.log("Upstream preview: (empty)");
    }

    // If upstream returned HTML (starts with '<'), wrap it into JSON to avoid client JSON parse errors
    const trimmed = (upstreamText || "").trim();
    if (trimmed && trimmed[0] === "<") {
      return res.status(502).json({
        ok: false,
        error: "Upstream returned non-JSON (HTML). See upstreamPreview",
        upstreamStatus,
        upstreamPreview: upstreamText.slice(0, 1200),
      });
    }

    // handle non-OK upstream statuses
    if (upstreamStatus < 200 || upstreamStatus >= 300) {
      return res.status(upstreamStatus).json({
        ok: false,
        error: "Upstream returned error",
        upstreamStatus,
        upstreamBody: upstreamText,
      });
    }

    // parse JSON safely
    try {
      const data = upstreamText ? JSON.parse(upstreamText) : null;
      return res.status(200).json(data);
    } catch (err) {
      return res.status(200).json({ ok: true, raw: upstreamText });
    }
  } catch (err) {
    console.error(new Date().toISOString(), "Server error /api/myapi:", err && err.stack ? err.stack : err);
    return res.status(502).json({ ok: false, error: String(err) });
  }
});

// Health check
app.get("/_health", (req, res) => res.status(200).send("ok"));

// Start server (Express on HTTP/1.1 is fine)
const port = process.env.PORT || 5501;
const server = http.createServer(app);
server.listen(port, () => console.log(`Listening on ${port}`));

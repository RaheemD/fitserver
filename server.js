// server.js
// Simple Node/Express proxy for OpenRouter.
// Paste this whole file exactly and redeploy.

const express = require("express");
const app = express();

// Increase JSON/body size to handle base64 images if needed (adjust limit if you want).
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// CORS - allows browser requests from any origin during testing.
// In production replace "*" with your frontend origin.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With"
  );
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Type");

  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// OpenRouter endpoint (proxy target)
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";


// Main route used by your frontend: POST to /api/myapi
app.post("/api/myapi", async (req, res) => {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) {
      return res.status(500).json({ error: "Server misconfigured: OPENROUTER_API_KEY missing" });
    }

    const body = req.body || {};

    // Normalize payload: accept either full OpenRouter payload or simple { prompt: "..." }
    let payload;
    if (body.messages || body.model) {
      payload = body;
    } else {
      payload = {
        model: body.model || "openai/gpt-4.1-mini",
        messages: [{ role: "user", content: String(body.prompt || "Hello") }],
        max_tokens: body.max_tokens || 300,
        temperature: typeof body.temperature === "number" ? body.temperature : 0.2
      };
      if (body.image_url) payload.image_url = body.image_url;
      if (body.image_base64) payload.image_base64 = body.image_base64;
    }

    // --- proxied request with debug logging ---
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify(payload),
    });

    // Read full upstream response text and log a truncated preview
    const upstreamText = await upstream.text().catch(() => "");
    console.log(">> Upstream status:", upstream.status);
    console.log(">> Upstream body (first 10000 chars):", upstreamText.slice(0, 10000));

    if (!upstream.ok) {
      // Forward upstream status and raw body to client for debugging
      const replyText = upstreamText || `Upstream returned status ${upstream.status}`;
      res.status(upstream.status).type("text/plain").send(replyText);
      return;
    }

    // Parse JSON if possible, otherwise return raw
    let data;
    try {
      data = upstreamText ? JSON.parse(upstreamText) : null;
    } catch (e) {
      data = { raw: upstreamText };
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(502).json({ error: String(err) });
  }
});

// Health / quick check
app.get("/_health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 5501;
app.listen(port, () => console.log(`Listening on ${port}`));

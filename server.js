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

    // --- Safe body reader ---
    let bodyText = "";
    req.on("data", chunk => (bodyText += chunk));
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(bodyText || "{}");
      } catch (e) {
        console.error("❌ Invalid JSON body from frontend:", bodyText);
        return res.status(400).send("Invalid JSON");
      }

      // Normalize payload (same logic as before)
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

      // --- proxy to OpenRouter ---
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(payload),
      });

      const text = await upstream.text();
      console.log(">> Upstream status:", upstream.status);
      console.log(">> Upstream body (first 10000 chars):", text.slice(0, 10000));

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      res.status(upstream.status).json(data);
    });
  } catch (err) {
    console.error("Server error:", err);
    res.status(502).json({ error: String(err) });
  }
});


// Health / quick check
app.get("/_health", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 5501;
app.listen(port, () => console.log(`Listening on ${port}`));


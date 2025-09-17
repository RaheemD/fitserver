// server.js
// Simple Express proxy for OpenRouter. Uses Node 18+ built-in fetch (no node-fetch dependency).

const express = require("express");
const app = express();
app.use(express.json());

// CORS - for dev left open; for production replace "*" with your domain
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const OPENROUTER_URL = "https://api.openrouter.ai/v1/chat/completions";

app.post("/api/myapi", async (req, res) => {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(500).json({ error: "Server misconfigured: OPENROUTER_API_KEY missing" });

    const body = req.body || {};
    const payload = body.messages ? body : {
      model: body.model || "openai/gpt-4.1-mini",
      messages: [{ role: "user", content: String(body.prompt || "Hello") }],
      max_tokens: body.max_tokens || 300,
      temperature: typeof body.temperature === "number" ? body.temperature : 0.2
    };

    // Use global fetch provided by Node 18+
    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Server error:", err);
    return res.status(502).json({ error: String(err) });
  }
});

const port = process.env.PORT || 5501;
app.listen(port, () => console.log(`Listening on ${port}`));

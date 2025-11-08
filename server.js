// server.js
const express = require("express");
const app = express();
const fetch = require("node-fetch");

// --- Body parsers ---
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// --- CORS setup (Render safe, all origins allowed for now) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Title, HTTP-Referer, X-Requested-With"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Force no compression (avoid HTTP/2 decode issues) ---
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-transform");
  res.setHeader("Accept-Encoding", "identity");
  next();
});

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// --- Proxy Route ---
app.post("/api/myapi", async (req, res) => {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return res.status(500).send("OPENROUTER_API_KEY missing");

    const payload = req.body.model
      ? req.body
      : {
          model: "google/gemini-2.5-flash",
          messages: [{ role: "user", content: String(req.body.prompt || "Hi") }],
          max_tokens: 300,
          temperature: 0.2,
        };

    const upstream = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    res.status(upstream.status).json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).json({ error: String(err) });
  }
});

// --- Health endpoint ---
app.get("/_health", (req, res) => res.send("ok"));

const port = process.env.PORT || 5501;
app.listen(port, () => console.log(`Listening on ${port}`));

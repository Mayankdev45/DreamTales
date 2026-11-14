const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

// ── Single model (free on OpenRouter). Override via .env: STORY_MODEL=...
const MODEL = process.env.STORY_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
const MAX_RETRIES = 2;          // retries on 429 / 5xx before streaming starts
const TIMEOUT_MS = 180000;      // hard cap per story
const API_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const SITE_URL = process.env.SITE_URL || `http://localhost:${PORT}`;
const RATE_MAX = parseInt(process.env.RATE_MAX) || 6;   // stories per IP per window
const RATE_WINDOW_MS = 10 * 60 * 1000;

app.use(cors());
app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public"))); // ONLY public/ is served

// Bad JSON body → JSON error (not Express HTML page)
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Invalid request body." });
  }
  next(err);
});

// ── Tiny per-IP rate limit (protects the free-tier daily quota) ──
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, arr] of hits) {
    const kept = arr.filter((t) => t > cutoff);
    kept.length ? hits.set(ip, kept) : hits.delete(ip);
  }
}, 60000).unref();

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => t > now - RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// Strip control chars/newlines so user text can't break the prompt layout
const clean = (v, max) =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// ── Prompts ─────────────────────────────────
function buildPrompts({ genre, setting, hero, trait, numScenes }) {
  const system = `You are an award-winning novelist. Write a single, tightly connected story.

Return ONLY valid JSON, no markdown, no text outside JSON. Keys MUST appear in this order:

{
  "title": "",
  "byline": "",
  "outline": "",
  "scenes": [
    { "scene_number": 1, "scene_title": "", "paragraphs": ["", ""] }
  ]
}

"outline": 3-4 SHORT sentences (max 70 words total). Fix BEFORE writing scenes: cast with names, central mystery, hidden truth, turning point, ending, and one-line beat per scene. Follow it strictly.

Rules:
- "title": 2-6 plain words only. NO digits, codes, designations, serial names (like "Kepler-186f", "X-9", "Unit 42"), colons, or subtitles. Never put such codes in the title.
- EXACTLY ${numScenes} scenes, EXACTLY 2 paragraphs each, 120-160 words per paragraph.
- Each scene continues directly from the previous one and moves the main plot.
- Never repeat earlier information. Characters remember past events and stay consistent.
- Locations transition naturally. Mystery appears early; tension builds.
- Meaningful dialogue in every scene (use \\" inside JSON strings). Show emotion, don't state it.
- Vivid cinematic description.
- Every scene ends on suspense or a cliffhanger, except the last: emotional, satisfying resolution that pays off the mystery.`;

  const user = `Genre: ${genre}
Setting: ${setting}
Hero: ${hero}
Hero personality: ${trait}

Write the story now. Exactly ${numScenes} scenes. Introduce the hero naturally in scene 1.`;

  return { system, user };
}

// ── Upstream call with retry (before stream begins) ──
async function openStream(payload, signal) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": SITE_URL,
        "X-Title": "DreamTales Story App",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (r.ok) return r;

    const retryable = [429, 500, 502, 503, 504].includes(r.status);
    const errText = await r.text();
    if (retryable && attempt < MAX_RETRIES) {
      await new Promise((ok) => setTimeout(ok, 1500 * (attempt + 1)));
      continue;
    }
    let msg = errText;
    try { msg = JSON.parse(errText).error?.message || errText; } catch {}
    console.error("OpenRouter error", r.status, msg);
    throw new Error(
      r.status === 429
        ? "Free model is rate-limited. Wait a bit and try again."
        : `Model error (${r.status}). Try again.`
    );
  }
}

// ── SSE reader: feeds content deltas only (ignores reasoning) ──
async function readSSE(body, onDelta) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue; // skips ": OPENROUTER PROCESSING" keepalives
      const d = line.slice(5).trim();
      if (d === "[DONE]") return;
      let j;
      try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw new Error(j.error.message || "Upstream stream error");
      const t = j.choices?.[0]?.delta?.content;
      if (t) onDelta(t);
    }
  }
}

// ── Incremental parser: emits meta once, then each complete scene object ──
function createSceneParser(onMeta, onScene) {
  let buf = "";
  let metaSent = false;
  let pos = 0, depth = 0, inStr = false, esc = false, objStart = -1, finished = false;

  const str = (m) => {
    if (!m) return "";
    try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
  };

  return (chunk) => {
    if (finished) return;
    buf += chunk;

    if (!metaSent) {
      const m = buf.match(/"scenes"\s*:\s*\[/);
      if (!m) return;
      const head = buf.slice(0, m.index);
      onMeta({
        title: str(head.match(/"title"\s*:\s*"((?:[^"\\]|\\.)*)"/)) || "Untitled",
        byline: str(head.match(/"byline"\s*:\s*"((?:[^"\\]|\\.)*)"/)),
      });
      metaSent = true;
      pos = m.index + m[0].length;
    }

    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") { if (depth++ === 0) objStart = pos; }
      else if (c === "}") {
        if (--depth === 0 && objStart !== -1) {
          try {
            const s = JSON.parse(buf.slice(objStart, pos + 1));
            let paras = s.paragraphs;
            if (typeof paras === "string") paras = paras.split(/\n{2,}/);
            paras = (Array.isArray(paras) ? paras : [])
              .map((x) => String(x).trim())
              .filter(Boolean);
            onScene({
              scene_number: s.scene_number,
              scene_title: String(s.scene_title || "Untitled scene"),
              paragraphs: paras,
            });
          } catch (e) {
            console.error("Bad scene JSON skipped:", e.message);
          }
          objStart = -1;
        }
      } else if (c === "]" && depth === 0) { finished = true; return; }
    }
  };
}

// ── POST /api/story  (NDJSON stream: meta → scene… → done) ──
app.post("/api/story", async (req, res) => {
  const b = req.body || {};
  const genre = clean(b.genre, 60);
  const setting = clean(b.setting, 60);
  const hero = clean(b.hero, 30) || "Arjun";
  const trait = clean(b.trait, 60);
  const numScenes = parseInt(b.numScenes);

  const placeholder = (v) => !v || v.toLowerCase() === "select";
  if (placeholder(genre) || placeholder(setting) || placeholder(trait)) {
    return res.status(400).json({ error: "Please choose genre, setting and hero's quality." });
  }
  if (!Number.isInteger(numScenes) || numScenes < 1 || numScenes > 8) {
    return res.status(400).json({ error: "Number of scenes must be between 1 and 8." });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY is not set." });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ error: "Too many stories. Wait a few minutes and try again." });
  }

  const { system, user } = buildPrompts({ genre, setting, hero, trait, numScenes });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  res.on("close", () => {
    clearTimeout(timer);
    if (!res.writableFinished) ctrl.abort(); // client left → stop upstream
  });

  let upstream;
  try {
    upstream = await openStream(
      {
        model: MODEL,
        stream: true,
        max_tokens: 800 + numScenes * 650, // scales with scenes; avoids truncated JSON
        temperature: 0.9,
        top_p: 0.95,
        reasoning: { enabled: false },     // no hidden thinking tokens = faster first scene
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      ctrl.signal
    );
  } catch (err) {
    clearTimeout(timer);
    return res.status(502).json({ error: err.message });
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (o) => res.write(JSON.stringify(o) + "\n");
  let count = 0;

  const feed = createSceneParser(
    (meta) => {
      // strip any trailing code-like token (contains a digit) the model slipped in
      const t = meta.title.replace(/[\s\-–—:]*\b\w*\d\w*\b\s*$/, "").trim() || meta.title;
      send({ type: "meta", title: t, byline: `A tale of ${hero}` });
    },
    (scene) => { count++; send({ type: "scene", scene }); }
  );

  try {
    await readSSE(upstream.body, feed);
    if (!count) send({ type: "error", error: "Model returned no scenes. Try again." });
    else send({ type: "done", scenes: count });
  } catch (err) {
    console.error("Stream error:", err.message);
    send({
      type: "error",
      error: ctrl.signal.aborted ? "Generation timed out. Try fewer scenes." : err.message,
    });
  }
  clearTimeout(timer);
  res.end();
});

app.listen(PORT, () => {
  console.log(`\nServer running at http://localhost:${PORT}  (model: ${MODEL})`);
});

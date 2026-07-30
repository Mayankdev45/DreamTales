const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/index.html");
});

// ── POST /api/story ─────────────────────────
app.post("/api/story", async (req, res) => {
  const { genre, setting, hero, trait, numScenes } = req.body;

  if (!genre || !setting || !hero || !trait || !numScenes) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  const API_KEY = process.env.OPENROUTER_API_KEY;

  if (!API_KEY) {
    return res.status(500).json({ error: "OPENROUTER_API_KEY is not set." });
  }

  const systemPrompt = `
You are an award-winning novelist and screenplay writer.

Your goal is to create stories that feel like professionally written novels.

IMPORTANT:
Think through the ENTIRE story before writing.

Return ONLY valid JSON.

JSON FORMAT:

{
  "title":"",
  "byline":"",
  "scenes":[
    {
      "scene_number":1,
      "scene_title":"",
      "paragraphs":[
        "",
        ""
      ]
    }
  ]
}

Rules:

- Create EXACTLY ${numScenes} scenes.
- Each scene contains EXACTLY 2 long paragraphs.
- Every scene continues directly from the previous one.
- Every scene advances the main plot.
- Never repeat previous information.
- Introduce mystery early.
- Build tension throughout.
- Characters must remember previous events.
- Characters must stay consistent.
- Locations must transition naturally.
- Every scene should include meaningful dialogue.
- Describe emotions instead of telling them.
- Use vivid cinematic descriptions.
- End every scene with suspense or a cliffhanger.
- The final scene should provide an emotional and satisfying ending.

Output ONLY valid JSON.
`;

  const userPrompt = `
Write a highly engaging novel.

Genre:
${genre}

Setting:
${setting}

Main Hero:
${hero}

Hero Personality:
${trait}

Requirements:

- Exactly ${numScenes} scenes.
- Exactly 2 long paragraphs in every scene.
- Introduce the hero naturally.
- Every scene must continue from the previous scene.
- Every scene must reveal something new.
- Include emotional dialogue.
- Include mystery and conflict.
- Build suspense.
- End every scene with a cliffhanger.
- End the final scene with a satisfying conclusion.
`;

  try {
    // ── PRIMARY MODEL (70B) ──
    let response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "Mythos Story App"
      },
      body: JSON.stringify({
        model: "deepseek/deepseek-chat-v3",
        max_tokens: 3500,
        temperature: 1.0,
        top_p: 0.95,
        presence_penalty: 0.5,
        frequency_penalty: 0.3,

        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      })
    });
    console.log(response.status);
    console.log(response.statusText);

    const text = await response.text();

console.log("OpenRouter Response:");
console.log(text);

let data;

try {
    data = JSON.parse(text);
} catch (err) {
    return res.status(500).json({
        error: "OpenRouter did not return valid JSON.",
        response: text
    });
}

    // ── FALLBACK MODEL (8B) ──
    if (!data.choices) {
      console.log("⚠️ Falling back to 8B model...");

      response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "qwen/qwen3-32b",
          max_tokens: 3500,
          temperature: 1.0,
          top_p: 0.95,
          presence_penalty: 0.5,
          frequency_penalty: 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ]
        })
      });

      const text2 = await response.text();

console.log("Fallback Response:");
console.log(text2);

try {
    data = JSON.parse(text2);
} catch (err) {
    return res.status(500).json({
        error: "Fallback model returned invalid JSON.",
        response: text2
    });
}
    }

    if (!data.choices || !data.choices[0]) {
      return res.status(500).json({ error: "Empty response from OpenRouter." });
    }

    let raw = data.choices[0].message.content || "";
    raw = raw
  .replace(/```json/gi, "")
  .replace(/```/g, "")
  .trim();

const start = raw.indexOf("{");
const end = raw.lastIndexOf("}");

if (start !== -1 && end !== -1) {
  raw = raw.substring(start, end + 1);
}

    let story;
    try {
      story = JSON.parse(raw);
    } catch (err) {
      console.error("Invalid JSON:\n", raw);
      return res.status(500).json({ error: "AI returned invalid JSON. Try again." });
    }

    res.json(story);

  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: "Failed to generate story. " + err.message });
  }
});

// ── START SERVER ──
app.listen(PORT, () => {
  console.log(`\n🌟 Server running at http://localhost:${PORT}`);
});

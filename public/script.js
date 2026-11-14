/* ─────────────────────────────────────────────
   DreamTales — Story Creator
   script.js  (streaming + one scene per page)
───────────────────────────────────────────── */

// ── State ────────────────────────────────────
let fullStoryText = "";
let scenes = [];          // scenes received so far
let current = 0;          // index of page being shown
let expected = 0;         // scenes requested
let done = false;         // stream finished OK
let failed = false;       // stream ended early

const LOADING_MESSAGES = [
  "Planning the plot arc…",
  "Crafting scene one…",
  "Polishing every word…",
  "Almost ready — your story awaits…",
];

// ── DOM refs ─────────────────────────────────
const genBtn      = document.getElementById("genBtn");
const btnText     = document.getElementById("btnText");
const errorBox    = document.getElementById("errorBox");
const loadingBar  = document.getElementById("loadingBar");
const loadingFill = document.getElementById("loadingFill");
const loadingMsg  = document.getElementById("loadingMsg");
const storyPage   = document.getElementById("storyPage");
const storyEnd    = document.getElementById("storyEnd");
const endCaption  = document.getElementById("endCaption");
const container   = document.getElementById("scenesContainer");
const prevBtn     = document.getElementById("prevBtn");
const nextBtn     = document.getElementById("nextBtn");
const pagerStatus = document.getElementById("pagerStatus");

// ── Buttons ───────────────────────────────────
document.getElementById("newStoryBtn").addEventListener("click", resetToForge);
document.getElementById("copyBtn").addEventListener("click", copyStory);
genBtn.addEventListener("click", generate);

prevBtn.addEventListener("click", () => {
  if (current > 0) renderPage(current - 1, true);
});
nextBtn.addEventListener("click", () => {
  nextBtn.classList.remove("ready");
  if (current < scenes.length - 1) renderPage(current + 1, true);
});

// ← / → keys flip pages (not while typing in a field)
document.addEventListener("keydown", (e) => {
  if (!storyPage.classList.contains("visible")) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft" && !prevBtn.disabled) prevBtn.click();
  if (e.key === "ArrowRight" && !nextBtn.disabled && !nextBtn.hidden) nextBtn.click();
});

// ── Main generate flow ───────────────────────
async function generate() {
  const genre     = document.getElementById("genre").value;
  const setting   = document.getElementById("setting").value;
  const hero      = document.getElementById("hero").value.trim() || "Arjun";
  const trait     = document.getElementById("trait").value;
  const numScenes = parseInt(document.getElementById("numScenes").value);

  if (!genre || !setting || !trait || !numScenes) {
    showError("Please choose a genre, setting, hero's quality and number of scenes.");
    return;
  }

  setLoading(true);
  hideError();
  storyPage.classList.remove("visible");
  storyEnd.classList.remove("visible");
  container.innerHTML = "";
  fullStoryText = "";
  scenes = [];
  current = 0;
  expected = numScenes;
  done = false;
  failed = false;
  showLoadingBar();

  let msgIndex = 0;
  loadingMsg.textContent = LOADING_MESSAGES[0];
  const msgTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % LOADING_MESSAGES.length;
    loadingMsg.textContent = LOADING_MESSAGES[msgIndex];
  }, 2200);

  let streamError = null;

  try {
    const response = await fetch("/api/story", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ genre, setting, hero, trait, numScenes }),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Server error. Please try again.");
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    const handle = (msg) => {
      if (msg.type === "meta") {
        beginStory(msg, genre, setting);
      } else if (msg.type === "scene") {
        const waiting = scenes.length > 0 && current === scenes.length - 1;
        const sc = msg.scene;
        scenes.push(sc);
        fullStoryText +=
          `Scene ${scenes.length}: ${sc.scene_title}\n\n${(sc.paragraphs || []).join("\n\n")}\n\n`;

        if (scenes.length === 1) {
          // first scene: swap loader for the reader
          clearInterval(msgTimer);
          finishLoadingBar();
          setTimeout(hideLoadingBar, 350);
          storyPage.classList.add("visible");
          renderPage(0, false);
          storyPage.scrollIntoView({ behavior: "smooth", block: "start" });
        } else {
          updatePager();
          // reader was waiting on the last page → tell them next is ready
          if (waiting) nextBtn.classList.add("ready");
        }
      } else if (msg.type === "error") {
        streamError = msg.error;
      }
    };

    for (;;) {
      const { done: rdDone, value } = await reader.read();
      if (rdDone) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        handle(msg);
      }
    }

    if (streamError) throw new Error(streamError);
    if (!scenes.length) throw new Error("No story received. Please try again.");

    done = true;
    updatePager();
  } catch (err) {
    showError(err.message);
    if (scenes.length) {
      failed = true;      // keep partial story readable
      updatePager();
    }
  } finally {
    clearInterval(msgTimer);
    hideLoadingBar();
    setLoading(false);
  }
}

// ── Story header ─────────────────────────────
function beginStory(meta, genre, setting) {
  document.getElementById("storyGenreTag").textContent =
    capitalize(genre) + " · " + capitalize(setting);
  document.getElementById("storyMainTitle").textContent = meta.title;
  document.getElementById("storyByline").textContent    = meta.byline || "";
  fullStoryText = meta.title + "\n\n";
}

// ── Pager: show ONE scene in the story section ──
function renderPage(i, scroll) {
  current = i;
  const sc    = scenes[i];
  const paras = sc.paragraphs || [];

  container.innerHTML = `
    <div class="scene">
      <div class="scene-number"></div>
      <div class="scene-title">${escapeHTML(sc.scene_title)}</div>
      <div class="scene-text">${paras.map((p) => `<p>${escapeHTML(p)}</p>`).join("")}</div>
    </div>
  `;
  const el = container.firstElementChild;
  requestAnimationFrame(() => el.classList.add("revealed"));

  updatePager();
  if (scroll) container.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updatePager() {
  const n        = scenes.length;
  const finished = done || failed;
  const total    = finished ? n : expected;
  const last     = current === n - 1;

  const label = container.querySelector(".scene-number");
  if (label) label.textContent = `Scene ${current + 1} of ${total}`;

  pagerStatus.textContent = `Page ${current + 1} of ${total}`;
  prevBtn.disabled = current === 0;

  nextBtn.classList.remove("waiting");
  if (!last) {
    nextBtn.hidden = false;
    nextBtn.disabled = false;
    nextBtn.textContent = "Next scene →";
  } else if (!finished) {
    nextBtn.hidden = false;
    nextBtn.disabled = true;
    nextBtn.classList.add("waiting");
    nextBtn.textContent = `Writing scene ${n + 1}…`;
  } else {
    nextBtn.hidden = true;
  }

  endCaption.textContent = failed
    ? "The story stopped early — try again for the full tale."
    : "The end of this tale — but never of stories.";
  storyEnd.classList.toggle("visible", finished && last);
}

// ── UI helpers ────────────────────────────────
function setLoading(on) {
  genBtn.disabled = on;
  if (on) {
    genBtn.classList.add("loading");
    btnText.textContent = "Creating your story…";
  } else {
    genBtn.classList.remove("loading");
    btnText.innerHTML = "Generate my story &rarr;";
  }
}

function showLoadingBar() {
  loadingBar.classList.add("visible");
  loadingMsg.classList.add("visible");
  loadingFill.style.transition = "none";
  loadingFill.style.width = "0%";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadingFill.style.transition = "width 10s ease";
      loadingFill.style.width = "85%";
    });
  });
}

function finishLoadingBar() {
  loadingFill.style.transition = "width 0.35s ease";
  loadingFill.style.width = "100%";
}

function hideLoadingBar() {
  loadingBar.classList.remove("visible");
  loadingMsg.classList.remove("visible");
  loadingFill.style.width = "0%";
}

function showError(msg) {
  errorBox.textContent = "Error: " + msg;
  errorBox.classList.add("visible");
}

function hideError() {
  errorBox.classList.remove("visible");
  errorBox.textContent = "";
}

function resetToForge() {
  storyPage.classList.remove("visible");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function copyStory() {
  navigator.clipboard
    .writeText(fullStoryText.trim())
    .then(() => {
      const btn = document.getElementById("copyBtn");
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy full story"), 2200);
    })
    .catch(() => alert("Copy failed — please copy manually."));
}

// ── Utils ─────────────────────────────────────
function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
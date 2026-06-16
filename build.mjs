import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const sourcePath = "/tmp/wt_283.txt";
const root = new URL("./", import.meta.url);
const fullDir = new URL("./assets/full/", root);
const highresDir = new URL("./assets/highres/", root);
const thumbDir = new URL("./assets/thumb/", root);
const dataDir = new URL("./assets/data/", root);
const originalsRoot = process.env.WT_ORIGINALS_DIR || "/tmp/wt_highres_extract";
const highresMaxEdge = Number(process.env.WT_HIGHRES_MAX_EDGE || 2400);
const highresQuality = Number(process.env.WT_HIGHRES_QUALITY || 82);

const stateUrl = "https://kvdb.io/GAEki9odowZhgkjtga5tr2/review-state";

function cleanInput(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("Could not find JSON in WeTransfer response");
  return raw.slice(start, end + 1);
}

function slug(value) {
  return value
    .replace(/^LOW_RES_[A-Z]+\//, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function download(url, fileUrl) {
  if (existsSync(fileUrl)) return;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed ${response.status}: ${url}`);
  }
  await pipeline(response.body, createWriteStream(fileUrl));
}

async function runImageTool(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function makeHighres(inputPath, outputUrl) {
  if (existsSync(outputUrl)) return true;
  const outputPath = fileURLToPath(outputUrl);
  try {
    await runImageTool("magick", [
      inputPath,
      "-auto-orient",
      "-resize",
      `${highresMaxEdge}x${highresMaxEdge}>`,
      "-quality",
      String(highresQuality),
      outputPath
    ]);
    return true;
  } catch (error) {
    console.warn(`Could not create high-res image for ${inputPath}: ${error.message}`);
    return false;
  }
}

async function mapLimit(items, limit, worker) {
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item, index);
    }
  });
  await Promise.all(workers);
}

function appHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tanja June 2026 Shot Review</title>
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='10' fill='%23235f56'/%3E%3Cpath d='M18 18h28v28H18z' fill='none' stroke='white' stroke-width='4'/%3E%3Cpath d='M24 38l6-7 5 5 5-8 6 10' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <p class="eyebrow">LOW_RES_WIDE_SELECT</p>
      <h1>Tanja June 2026 Shot Review</h1>
    </div>
    <div class="cloud-status" id="cloudStatus">Loading shared review...</div>
  </header>

  <main>
    <section class="summary" aria-label="Review summary">
      <div class="stat"><span id="totalCount">336</span><small>Total</small></div>
      <div class="stat approved"><span id="approvedCount">0</span><small>Approved</small></div>
      <div class="stat maybe"><span id="maybeCount">0</span><small>Maybe</small></div>
      <div class="stat rejected"><span id="rejectedCount">0</span><small>Rejected</small></div>
      <div class="stat noted"><span id="notedCount">0</span><small>Notes</small></div>
    </section>

    <section class="controls" aria-label="Review controls">
      <label>
        Folder
        <select id="folderFilter">
          <option value="all">All folders</option>
          <option value="LOW_RES_PORTRAIT">Portrait</option>
          <option value="LOW_RES_STILL">Still</option>
        </select>
      </label>
      <label>
        Status
        <select id="statusFilter">
          <option value="all">All statuses</option>
          <option value="unreviewed">Unreviewed</option>
          <option value="approved">Approved</option>
          <option value="maybe">Maybe</option>
          <option value="rejected">Rejected</option>
          <option value="noted">Has note</option>
        </select>
      </label>
      <label class="search">
        Search filename
        <input id="searchInput" type="search" placeholder="SHOT_01_009 or OW9A...">
      </label>
      <label>
        Columns
        <input id="columnSlider" type="range" min="2" max="7" value="4">
      </label>
      <label>
        Reviewer
        <input id="reviewerInput" type="text" placeholder="Your name">
      </label>
      <button id="exportBtn" type="button">Export decisions</button>
      <button id="backupBtn" type="button">Backup JSON</button>
      <button id="reloadBtn" type="button">Reload shared review</button>
    </section>

    <section class="grid" id="grid" aria-label="Shot grid"></section>
    <p class="empty" id="emptyState" hidden>No shots match these filters.</p>
  </main>

  <dialog class="lightbox" id="lightbox">
    <button class="icon close" id="closeLightbox" aria-label="Close large view">&times;</button>
    <button class="icon prev" id="prevShot" aria-label="Previous shot">‹</button>
    <figure>
      <img id="lightboxImage" alt="">
    </figure>
    <aside class="review-panel">
      <p class="counter" id="shotCounter"></p>
      <h2 id="shotTitle"></h2>
      <p class="meta" id="shotMeta"></p>
      <button class="image-link" id="openHighres" type="button">Open high-res</button>
      <div class="decision-buttons">
        <button type="button" data-status="approved">Approve</button>
        <button type="button" data-status="maybe">Maybe</button>
        <button type="button" data-status="rejected">Reject</button>
        <button type="button" data-status="">Clear</button>
      </div>
      <label class="note-label">
        Notes
        <textarea id="lightboxNote" rows="7" placeholder="Write thoughts, retouch notes, usage ideas, or why this is approved/rejected."></textarea>
      </label>
      <p class="save-hint" id="saveHint">Notes save automatically.</p>
    </aside>
    <button class="icon next" id="nextShot" aria-label="Next shot">›</button>
  </dialog>

  <script src="assets/data/shots.js"></script>
  <script>
    window.SHOT_REVIEW_CONFIG = {
      stateUrl: ${JSON.stringify(stateUrl)}
    };
  </script>
  <script src="app.js"></script>
</body>
</html>
`;
}

function stylesCss() {
  return `:root {
  color-scheme: light;
  --ink: #1f2326;
  --muted: #667071;
  --line: #d7dddc;
  --paper: #fbfaf7;
  --panel: #ffffff;
  --soft: #edf4f1;
  --accent: #235f56;
  --approved: #227447;
  --maybe: #a76a13;
  --rejected: #9f3434;
  --shadow: 0 14px 42px rgba(28, 36, 33, 0.16);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
}

button, input, select, textarea {
  font: inherit;
}

button {
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--ink);
  border-radius: 6px;
  min-height: 38px;
  padding: 8px 12px;
  cursor: pointer;
}

button:hover { border-color: var(--accent); }

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: center;
  padding: 16px 24px;
  background: rgba(251, 250, 247, 0.94);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(12px);
}

.brand h1 {
  margin: 0;
  font-size: 24px;
  letter-spacing: 0;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 12px;
  text-transform: uppercase;
}

.cloud-status {
  max-width: 380px;
  color: var(--muted);
  font-size: 13px;
  text-align: right;
}

main {
  padding: 20px 24px 48px;
}

.summary {
  display: grid;
  grid-template-columns: repeat(5, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.stat {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  padding: 12px 14px;
}

.stat span {
  display: block;
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}

.stat small {
  color: var(--muted);
}

.stat.approved span { color: var(--approved); }
.stat.maybe span { color: var(--maybe); }
.stat.rejected span { color: var(--rejected); }
.stat.noted span { color: var(--accent); }

.controls {
  display: grid;
  grid-template-columns: 160px 160px minmax(220px, 1fr) 140px 180px auto auto auto;
  gap: 10px;
  align-items: end;
  margin-bottom: 10px;
}

label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 12px;
}

input, select, textarea {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink);
  padding: 8px 10px;
}

textarea {
  resize: vertical;
  line-height: 1.45;
}

.grid {
  --columns: 4;
  display: grid;
  grid-template-columns: repeat(var(--columns), minmax(0, 1fr));
  gap: 14px;
}

.card {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(28, 36, 33, 0.06);
}

.thumb-button {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: #eef0ed;
  min-height: 0;
  overflow: hidden;
}

.thumb-button img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.card-body {
  padding: 10px;
  display: grid;
  gap: 8px;
}

.filename {
  min-height: 36px;
  font-size: 13px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.folder {
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
}

.status-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.status-row button {
  min-height: 32px;
  padding: 5px 4px;
  font-size: 12px;
}

.status-approved .thumb-button { outline: 4px solid rgba(34, 116, 71, 0.45); outline-offset: -4px; }
.status-maybe .thumb-button { outline: 4px solid rgba(167, 106, 19, 0.5); outline-offset: -4px; }
.status-rejected .thumb-button { outline: 4px solid rgba(159, 52, 52, 0.48); outline-offset: -4px; }

.card[data-status="approved"] .btn-approve,
.decision-buttons button[data-status="approved"].active { background: var(--approved); color: white; border-color: var(--approved); }
.card[data-status="maybe"] .btn-maybe,
.decision-buttons button[data-status="maybe"].active { background: var(--maybe); color: white; border-color: var(--maybe); }
.card[data-status="rejected"] .btn-reject,
.decision-buttons button[data-status="rejected"].active { background: var(--rejected); color: white; border-color: var(--rejected); }

.note-small {
  min-height: 72px;
  font-size: 13px;
}

.empty {
  margin: 48px 0;
  text-align: center;
  color: var(--muted);
}

.lightbox {
  width: min(1600px, calc(100vw - 24px));
  height: min(960px, calc(100vh - 24px));
  padding: 0;
  border: 0;
  border-radius: 8px;
  box-shadow: var(--shadow);
  background: #151716;
  color: #fff;
}

.lightbox::backdrop {
  background: rgba(0, 0, 0, 0.72);
}

.lightbox[open] {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) 320px 48px;
}

.lightbox figure {
  margin: 0;
  display: grid;
  place-items: center;
  min-width: 0;
  min-height: 0;
  background: #101211;
}

.lightbox img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  cursor: zoom-in;
}

.review-panel {
  background: var(--panel);
  color: var(--ink);
  padding: 18px;
  display: grid;
  align-content: start;
  gap: 14px;
  overflow: auto;
}

.review-panel h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.25;
  overflow-wrap: anywhere;
}

.counter, .meta, .save-hint {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}

.image-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 36px;
  border: 1px solid var(--line);
  border-radius: 6px;
  color: var(--ink);
  background: var(--soft);
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}

.image-link:hover {
  border-color: var(--accent);
}

.decision-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.icon {
  border: 0;
  border-radius: 0;
  color: white;
  background: rgba(255,255,255,0.06);
  font-size: 36px;
  min-height: 100%;
}

.icon:hover {
  background: rgba(255,255,255,0.12);
  border: 0;
}

.close {
  position: absolute;
  right: 8px;
  top: 8px;
  min-height: 42px;
  width: 42px;
  border-radius: 999px;
  z-index: 2;
}

@media (max-width: 1040px) {
  .controls {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .summary {
    grid-template-columns: repeat(5, minmax(80px, 1fr));
  }

  .grid {
    --columns: 3;
  }

  .lightbox[open] {
    grid-template-columns: 42px minmax(0, 1fr) 42px;
    grid-template-rows: minmax(0, 1fr) auto;
  }

  .review-panel {
    grid-column: 1 / -1;
    max-height: 42vh;
  }
}

@media (max-width: 680px) {
  .topbar {
    align-items: start;
    flex-direction: column;
    padding: 14px;
  }

  .cloud-status {
    text-align: left;
  }

  main {
    padding: 14px;
  }

  .summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .controls {
    grid-template-columns: 1fr;
  }

  .grid {
    --columns: 2;
    gap: 10px;
  }

  .status-row {
    grid-template-columns: repeat(2, 1fr);
  }
}
`;
}

function appJs() {
  return `"use strict";

const shots = window.SHOTS || [];
const config = window.SHOT_REVIEW_CONFIG || {};
const statusLabels = { approved: "Approved", maybe: "Maybe", rejected: "Rejected", "": "Unreviewed" };
const els = {
  grid: document.getElementById("grid"),
  emptyState: document.getElementById("emptyState"),
  cloudStatus: document.getElementById("cloudStatus"),
  folderFilter: document.getElementById("folderFilter"),
  statusFilter: document.getElementById("statusFilter"),
  searchInput: document.getElementById("searchInput"),
  columnSlider: document.getElementById("columnSlider"),
  reviewerInput: document.getElementById("reviewerInput"),
  totalCount: document.getElementById("totalCount"),
  approvedCount: document.getElementById("approvedCount"),
  maybeCount: document.getElementById("maybeCount"),
  rejectedCount: document.getElementById("rejectedCount"),
  notedCount: document.getElementById("notedCount"),
  exportBtn: document.getElementById("exportBtn"),
  backupBtn: document.getElementById("backupBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  lightbox: document.getElementById("lightbox"),
  lightboxImage: document.getElementById("lightboxImage"),
  shotCounter: document.getElementById("shotCounter"),
  shotTitle: document.getElementById("shotTitle"),
  shotMeta: document.getElementById("shotMeta"),
  openHighres: document.getElementById("openHighres"),
  lightboxNote: document.getElementById("lightboxNote"),
  saveHint: document.getElementById("saveHint"),
  closeLightbox: document.getElementById("closeLightbox"),
  prevShot: document.getElementById("prevShot"),
  nextShot: document.getElementById("nextShot")
};

let state = { version: 1, updatedAt: new Date().toISOString(), items: {} };
let filtered = [...shots];
let activeIndex = 0;
let saveTimer = null;
let isSaving = false;
let lastCloudJson = "";

function localKey() {
  return "tanja-shot-review-state-v1";
}

function setStatus(message, tone = "") {
  els.cloudStatus.textContent = message;
  els.cloudStatus.dataset.tone = tone;
}

function itemState(id) {
  return state.items[id] || {};
}

function reviewer() {
  return els.reviewerInput.value.trim() || "Reviewer";
}

function mergeState(next) {
  if (!next || typeof next !== "object") return;
  state = {
    version: 1,
    updatedAt: next.updatedAt || new Date().toISOString(),
    items: next.items && typeof next.items === "object" ? next.items : {}
  };
  localStorage.setItem(localKey(), JSON.stringify(state));
}

async function loadState() {
  const local = localStorage.getItem(localKey());
  if (local) {
    try { mergeState(JSON.parse(local)); } catch {}
  }
  if (!config.stateUrl) {
    setStatus("Local-only mode. Export decisions when finished.", "warn");
    return;
  }
  try {
    const response = await fetch(config.stateUrl, { cache: "no-store" });
    if (response.ok) {
      const text = await response.text();
      lastCloudJson = text;
      mergeState(JSON.parse(text));
      setStatus("Shared review loaded. Changes save for everyone.", "ok");
    } else if (response.status === 404) {
      setStatus("Shared review is ready. First change will create it.", "warn");
    } else {
      setStatus("Shared review could not load. Local backup is active.", "warn");
    }
  } catch {
    setStatus("Offline or shared review unavailable. Local backup is active.", "warn");
  }
}

function scheduleSave() {
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(localKey(), JSON.stringify(state));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
  updateStats();
}

async function saveState() {
  if (!config.stateUrl || isSaving) return;
  isSaving = true;
  setStatus("Saving shared review...", "");
  try {
    const payload = JSON.stringify(state);
    const response = await fetch(config.stateUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload
    });
    if (!response.ok) throw new Error(String(response.status));
    lastCloudJson = payload;
    setStatus("Saved for everyone.", "ok");
  } catch {
    setStatus("Could not save online. Local backup is still saved.", "warn");
  } finally {
    isSaving = false;
  }
}

async function pollCloud() {
  if (!config.stateUrl || document.hidden || isSaving) return;
  try {
    const response = await fetch(config.stateUrl, { cache: "no-store" });
    if (!response.ok) return;
    const text = await response.text();
    if (text && text !== lastCloudJson) {
      lastCloudJson = text;
      mergeState(JSON.parse(text));
      render();
      updateLightbox();
      setStatus("Shared review refreshed.", "ok");
    }
  } catch {}
}

function updateShot(id, patch, options = {}) {
  const current = itemState(id);
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: reviewer()
  };
  if (!next.status && !next.note) {
    delete state.items[id];
  } else {
    state.items[id] = next;
  }
  scheduleSave();
  if (options.render !== false) renderCard(id);
}

function statusClass(status) {
  return status ? "status-" + status : "";
}

function shotLabel(shot) {
  return shot.name.split("/").pop();
}

function filteredShots() {
  const folder = els.folderFilter.value;
  const status = els.statusFilter.value;
  const query = els.searchInput.value.trim().toLowerCase();
  return shots.filter((shot) => {
    const data = itemState(shot.id);
    const shotStatus = data.status || "";
    if (folder !== "all" && shot.folder !== folder) return false;
    if (status === "unreviewed" && shotStatus) return false;
    if (status === "approved" && shotStatus !== "approved") return false;
    if (status === "maybe" && shotStatus !== "maybe") return false;
    if (status === "rejected" && shotStatus !== "rejected") return false;
    if (status === "noted" && !(data.note || "").trim()) return false;
    if (query && !shot.name.toLowerCase().includes(query)) return false;
    return true;
  });
}

function render() {
  filtered = filteredShots();
  els.grid.style.setProperty("--columns", els.columnSlider.value);
  els.grid.innerHTML = filtered.map(cardHtml).join("");
  els.emptyState.hidden = filtered.length > 0;
  updateStats();
}

function cardHtml(shot) {
  const data = itemState(shot.id);
  const status = data.status || "";
  const note = data.note || "";
  return \`<article class="card \${statusClass(status)}" data-id="\${shot.id}" data-status="\${status}">
    <button class="thumb-button" type="button" style="aspect-ratio:\${shot.width}/\${shot.height}" aria-label="Open \${escapeHtml(shotLabel(shot))}">
      <img src="\${shot.thumb}" alt="\${escapeHtml(shotLabel(shot))}" loading="lazy" width="\${shot.thumbWidth}" height="\${shot.thumbHeight}">
    </button>
    <div class="card-body">
      <div>
        <div class="folder">\${shot.folder.replace("LOW_RES_", "")}</div>
        <div class="filename">\${escapeHtml(shotLabel(shot))}</div>
      </div>
      <div class="status-row">
        <button type="button" class="btn-approve" data-set-status="approved">Approve</button>
        <button type="button" class="btn-maybe" data-set-status="maybe">Maybe</button>
        <button type="button" class="btn-reject" data-set-status="rejected">Reject</button>
        <button type="button" data-set-status="">Clear</button>
      </div>
      <textarea class="note-small" data-note placeholder="Notes beside this shot">\${escapeHtml(note)}</textarea>
    </div>
  </article>\`;
}

function renderCard(id) {
  const existing = els.grid.querySelector(\`.card[data-id="\${CSS.escape(id)}"]\`);
  if (!existing) {
    updateStats();
    return;
  }
  const shot = shots.find((item) => item.id === id);
  if (!shot) return;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = cardHtml(shot);
  existing.replaceWith(wrapper.firstElementChild);
}

function updateStats() {
  const values = Object.values(state.items || {});
  els.totalCount.textContent = shots.length;
  els.approvedCount.textContent = values.filter((item) => item.status === "approved").length;
  els.maybeCount.textContent = values.filter((item) => item.status === "maybe").length;
  els.rejectedCount.textContent = values.filter((item) => item.status === "rejected").length;
  els.notedCount.textContent = values.filter((item) => (item.note || "").trim()).length;
}

function openLightbox(id) {
  const index = filtered.findIndex((shot) => shot.id === id);
  activeIndex = Math.max(0, index);
  els.lightbox.showModal();
  updateLightbox();
}

function updateLightbox() {
  if (!els.lightbox.open || !filtered.length) return;
  const shot = filtered[activeIndex] || filtered[0];
  if (!shot) return;
  const data = itemState(shot.id);
  const imageSrc = highresSrc(shot);
  els.lightboxImage.src = imageSrc;
  els.lightboxImage.alt = shotLabel(shot);
  els.openHighres.dataset.href = imageSrc;
  els.openHighres.textContent = shot.highres ? "Open high-res" : "Open image";
  els.shotCounter.textContent = \`\${activeIndex + 1} of \${filtered.length}\`;
  els.shotTitle.textContent = shotLabel(shot);
  els.shotMeta.textContent = \`\${shot.folder.replace("LOW_RES_", "")} · \${shot.width} x \${shot.height} source · \${statusLabels[data.status || ""]}\`;
  els.lightboxNote.value = data.note || "";
  document.querySelectorAll(".decision-buttons button").forEach((button) => {
    button.classList.toggle("active", button.dataset.status === (data.status || ""));
  });
}

function moveLightbox(direction) {
  if (!filtered.length) return;
  activeIndex = (activeIndex + direction + filtered.length) % filtered.length;
  updateLightbox();
}

function activeShot() {
  return filtered[activeIndex];
}

function highresSrc(shot) {
  return shot.highres || shot.full;
}

function openHighresImage() {
  const shot = activeShot();
  if (!shot) return;
  const opened = window.open(highresSrc(shot), "_blank");
  if (opened) {
    opened.opener = null;
  } else {
    window.location.assign(highresSrc(shot));
  }
}

function exportText() {
  const rows = shots
    .map((shot) => ({ shot, data: itemState(shot.id) }))
    .filter(({ data }) => data.status || (data.note || "").trim());
  const lines = [
    "Tanja June 2026 Shot Review",
    "Exported: " + new Date().toLocaleString(),
    "",
    "Summary",
    "Approved: " + rows.filter((row) => row.data.status === "approved").length,
    "Maybe: " + rows.filter((row) => row.data.status === "maybe").length,
    "Rejected: " + rows.filter((row) => row.data.status === "rejected").length,
    "With notes: " + rows.filter((row) => (row.data.note || "").trim()).length,
    "",
    "Selections",
    ...rows.map(({ shot, data }) => [
      statusLabels[data.status || ""] || "Unreviewed",
      shot.name,
      data.note ? "Note: " + data.note.replace(/\\s+/g, " ").trim() : "",
      data.updatedBy ? "By: " + data.updatedBy : "",
      data.updatedAt ? "Updated: " + data.updatedAt : ""
    ].filter(Boolean).join(" | "))
  ];
  downloadFile("tanja-shot-review-decisions.txt", lines.join("\\n"));
}

function backupJson() {
  downloadFile("tanja-shot-review-backup.json", JSON.stringify(state, null, 2));
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

els.grid.addEventListener("click", (event) => {
  const card = event.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  const statusButton = event.target.closest("[data-set-status]");
  if (statusButton) {
    updateShot(id, { status: statusButton.dataset.setStatus });
    return;
  }
  if (event.target.closest(".thumb-button")) {
    openLightbox(id);
  }
});

els.grid.addEventListener("input", (event) => {
  if (!event.target.matches("[data-note]")) return;
  const card = event.target.closest(".card");
  updateShot(card.dataset.id, { note: event.target.value }, { render: false });
});

document.querySelector(".decision-buttons").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  const shot = activeShot();
  if (!button || !shot) return;
  updateShot(shot.id, { status: button.dataset.status });
  updateLightbox();
});

els.lightboxNote.addEventListener("input", () => {
  const shot = activeShot();
  if (!shot) return;
  els.saveHint.textContent = "Saving note...";
  updateShot(shot.id, { note: els.lightboxNote.value });
  setTimeout(() => { els.saveHint.textContent = "Notes save automatically."; }, 500);
});

[els.folderFilter, els.statusFilter, els.searchInput, els.columnSlider].forEach((control) => {
  control.addEventListener("input", () => {
    render();
    if (activeIndex >= filtered.length) activeIndex = 0;
  });
});

els.reviewerInput.addEventListener("input", () => {
  localStorage.setItem("tanja-shot-review-reviewer", els.reviewerInput.value);
});

els.closeLightbox.addEventListener("click", () => els.lightbox.close());
els.openHighres.addEventListener("click", openHighresImage);
els.lightboxImage.addEventListener("click", openHighresImage);
els.prevShot.addEventListener("click", () => moveLightbox(-1));
els.nextShot.addEventListener("click", () => moveLightbox(1));
els.exportBtn.addEventListener("click", exportText);
els.backupBtn.addEventListener("click", backupJson);
els.reloadBtn.addEventListener("click", async () => {
  await loadState();
  render();
  updateLightbox();
});

window.addEventListener("keydown", (event) => {
  if (!els.lightbox.open) return;
  if (event.target === els.lightboxNote) return;
  const shot = activeShot();
  if (event.key === "Escape") els.lightbox.close();
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
  if (!shot) return;
  if (event.key.toLowerCase() === "a") { updateShot(shot.id, { status: "approved" }); updateLightbox(); }
  if (event.key.toLowerCase() === "m") { updateShot(shot.id, { status: "maybe" }); updateLightbox(); }
  if (event.key.toLowerCase() === "r") { updateShot(shot.id, { status: "rejected" }); updateLightbox(); }
});

async function init() {
  els.reviewerInput.value = localStorage.getItem("tanja-shot-review-reviewer") || "";
  await loadState();
  render();
  setInterval(pollCloud, 15000);
}

init();
`;
}

async function main() {
  await mkdir(fullDir, { recursive: true });
  await mkdir(highresDir, { recursive: true });
  await mkdir(thumbDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const raw = await readFile(sourcePath, "utf8");
  const transfer = JSON.parse(cleanInput(raw));
  const files = transfer.files.filter((file) => file.preview?.url && file.preview?.thumbnailUrl);

  const shots = files.map((file, index) => {
    const folder = file.name.split("/")[0] || "ROOT";
    const filename = basename(file.name);
    const id = file.id;
    const short = `${String(index + 1).padStart(3, "0")}-${slug(filename)}`;
    const fullName = `${short}.webp`;
    const highresName = `${short}.webp`;
    const thumbName = `${short}.webp`;
    const meta = file.preview.originalFileMetadata || {};
    return {
      id,
      name: file.name,
      folder,
      filename,
      size: file.size,
      width: meta.width || 1,
      height: meta.height || 1,
      thumbWidth: meta.width && meta.height ? Math.round(512) : 512,
      thumbHeight: meta.width && meta.height ? Math.max(1, Math.round(512 * meta.height / meta.width)) : 512,
      full: `assets/full/${fullName}`,
      highres: `assets/highres/${highresName}`,
      thumb: `assets/thumb/${thumbName}`,
      fullUrl: file.preview.url,
      thumbUrl: file.preview.thumbnailUrl,
      fullFile: new URL(`./assets/full/${fullName}`, root),
      highresFile: new URL(`./assets/highres/${highresName}`, root),
      originalFile: join(originalsRoot, file.name),
      thumbFile: new URL(`./assets/thumb/${thumbName}`, root)
    };
  });

  console.log(`Preparing ${shots.length} shots`);
  await mapLimit(shots, 8, async (shot, index) => {
    await download(shot.fullUrl, shot.fullFile);
    await download(shot.thumbUrl, shot.thumbFile);
    if (existsSync(shot.originalFile)) {
      const highresReady = await makeHighres(shot.originalFile, shot.highresFile);
      if (!highresReady) delete shot.highres;
    } else {
      console.warn(`Missing original file for ${shot.name}; lightbox will use preview fallback`);
      delete shot.highres;
    }
    if (index % 20 === 0) console.log(`Downloaded ${index}/${shots.length}`);
  });

  const publicShots = shots.map(({ fullUrl, thumbUrl, fullFile, highresFile, originalFile, thumbFile, ...shot }) => shot);
  await writeFile(new URL("./index.html", root), appHtml());
  await writeFile(new URL("./styles.css", root), stylesCss());
  await writeFile(new URL("./app.js", root), appJs());
  await writeFile(
    new URL("./assets/data/shots.js", root),
    `window.SHOTS = ${JSON.stringify(publicShots, null, 2)};\n`
  );
  await writeFile(
    new URL("./README.md", root),
    `# Tanja June 2026 Shot Review\n\nExternally shareable shot-review app for LOW_RES_WIDE_SELECT.\n\n- ${publicShots.length} images\n- Portrait: ${publicShots.filter((shot) => shot.folder === "LOW_RES_PORTRAIT").length}\n- Still: ${publicShots.filter((shot) => shot.folder === "LOW_RES_STILL").length}\n- High-resolution opened images: up to ${highresMaxEdge}px on the long edge\n- Shared review state: ${stateUrl}\n\nThe app saves approve / maybe / reject decisions and notes to shared review state, with local backup and export options.\n`
  );
  console.log("Build complete");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

"use strict";

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
  return `<article class="card ${statusClass(status)}" data-id="${shot.id}" data-status="${status}">
    <button class="thumb-button" type="button" style="aspect-ratio:${shot.width}/${shot.height}" aria-label="Open ${escapeHtml(shotLabel(shot))}">
      <img src="${shot.thumb}" alt="${escapeHtml(shotLabel(shot))}" loading="lazy" width="${shot.thumbWidth}" height="${shot.thumbHeight}">
    </button>
    <div class="card-body">
      <div>
        <div class="folder">${shot.folder.replace("LOW_RES_", "")}</div>
        <div class="filename">${escapeHtml(shotLabel(shot))}</div>
      </div>
      <div class="status-row">
        <button type="button" class="btn-approve" data-set-status="approved">Approve</button>
        <button type="button" class="btn-maybe" data-set-status="maybe">Maybe</button>
        <button type="button" class="btn-reject" data-set-status="rejected">Reject</button>
        <button type="button" data-set-status="">Clear</button>
      </div>
      <textarea class="note-small" data-note placeholder="Notes beside this shot">${escapeHtml(note)}</textarea>
    </div>
  </article>`;
}

function renderCard(id) {
  const existing = els.grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
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
  els.lightboxImage.src = shot.full;
  els.lightboxImage.alt = shotLabel(shot);
  els.shotCounter.textContent = `${activeIndex + 1} of ${filtered.length}`;
  els.shotTitle.textContent = shotLabel(shot);
  els.shotMeta.textContent = `${shot.folder.replace("LOW_RES_", "")} · ${shot.width} x ${shot.height} source · ${statusLabels[data.status || ""]}`;
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
      data.note ? "Note: " + data.note.replace(/\s+/g, " ").trim() : "",
      data.updatedBy ? "By: " + data.updatedBy : "",
      data.updatedAt ? "Updated: " + data.updatedAt : ""
    ].filter(Boolean).join(" | "))
  ];
  downloadFile("tanja-shot-review-decisions.txt", lines.join("\n"));
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

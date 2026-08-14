"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  apiBase: "",
  healthOk: false,
  busy: false,
  currentTask: null,
  currentQuery: "",
  rawResponse: null,
  candidates: [],
  selectedIndex: -1,
  lightboxIndex: -1,
  objectUrls: new Set(),
  previewQueue: [],
  previewActive: 0,
  previewConcurrency: 6,
  previewQueued: new Set(),
  previewLoaded: 0,
  previewFailed: 0,
  previewObserver: null,
  serverGeneration: 0,
  zoom: { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 },
};

const GREETINGS = new Set([
  "hi", "hello", "hey", "xin chao", "xin chào", "chao", "chào", "alo",
  "hello there", "good morning", "good afternoon", "good evening"
]);

const HEALTH_PHRASES = [
  "health", "check server", "server?", "server còn sống không", "server con song khong",
  "kiểm tra server", "kiem tra server", "ping server", "server status", "status server"
];

const BTC_SCORE_KS = [1, 5, 20, 50, 100];
const PTS_KEYS = [
  "actual_pts_time", "pts_time", "target_pts_time", "pts_time_technical",
  "middle_pts_time", "center_pts_time"
];
const INTERVAL_PAIRS = [
  ["start_pts_time_technical", "end_pts_time_technical"],
  ["start_pts_time", "end_pts_time"],
  ["start_pts", "end_pts"],
  ["start_time", "end_time"],
];

function nowTime() {
  return new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function normalizeText(s) {
  return String(s || "").trim().replace(/\s+/g, " ");
}

function foldText(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[!?.,;:]+$/g, "")
    .trim();
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getApiBase() {
  return String($("apiServer").value || "").trim().replace(/\/+$/, "");
}

function apiUrl(path) {
  const base = getApiBase();
  if (!base) throw new Error("Chưa nhập API Server.");
  return base + path;
}

function setHealth(kind, text) {
  const dot = $("healthDot");
  dot.className = `health-dot ${kind}`;
  $("healthText").textContent = text;
}

function addMessage(role, text, options = {}) {
  const node = document.createElement("div");
  node.className = `message ${role}${options.error ? " error" : ""}`;
  node.textContent = text;
  if (options.meta) {
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = options.meta;
    node.appendChild(meta);
  }
  $("chatLog").appendChild(node);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return node;
}

function setTaskBadge(task, source = "") {
  const badge = $("taskBadge");
  badge.className = `task-badge ${task ? task.toLowerCase() : "neutral"}`;
  badge.textContent = task || "AUTO";
  $("routeHint").textContent = task ? `${task} · ${source || "detected"}` : "BTC task auto-route";
}

function parseBtcTask(raw) {
  const original = String(raw || "").trim();
  if (!original) return { task: null, query: "", source: "empty" };

  const firstChunk = original.slice(0, 320);
  const patterns = [
    { re: /^\s*\[\s*(KIS|TRAKE|QA)\s*\]\s*[:|\-–—]?\s*/i, source: "prefix" },
    { re: /^\s*#\s*(KIS|TRAKE|QA)\b\s*[:|\-–—]?\s*/i, source: "prefix" },
    { re: /^\s*(KIS|TRAKE|QA)\s*[:|]\s*/i, source: "prefix" },
    { re: /^\s*task[_\s-]*type\s*[:=]\s*(KIS|TRAKE|QA)\s*[:|\-–—]?\s*/i, source: "task_type" },
    { re: /^\s*(KIS|TRAKE|QA)\s*[-_ ]*query(?:[-_ ]*\d+)?(?:\s*\([^\n]*\))?\s*[:|\-–—]?\s*/i, source: "BTC title" },
  ];

  for (const { re, source } of patterns) {
    const m = original.match(re);
    if (m) {
      const task = m[1].toUpperCase();
      const query = original.slice(m[0].length).trim();
      return { task, query: query || original, source };
    }
  }

  const titleMatch = firstChunk.match(/\b(KIS|TRAKE|QA)\s*[-_ ]*query\b/i);
  if (titleMatch) {
    const task = titleMatch[1].toUpperCase();
    const lines = original.split(/\r?\n/);
    const firstLineHasTitle = /\b(KIS|TRAKE|QA)\s*[-_ ]*query\b/i.test(lines[0] || "");
    return { task, query: firstLineHasTitle ? lines.slice(1).join("\n").trim() || original : original, source: "BTC title" };
  }

  if (/\bE1\s*[:：].*\bE2\s*[:：]/is.test(original)) {
    return { task: "TRAKE", query: original, source: "E1/E2 inferred" };
  }

  const folded = foldText(original);
  if (/\b(ai|gì|gi|nào|nao|đâu|dau|khi nào|khi nao|bao nhiêu|bao nhieu|what|who|where|when|which|how many|why)\b/.test(folded) || /\?$/.test(original)) {
    return { task: "QA", query: original, source: "question inferred" };
  }

  return { task: "KIS", query: original, source: "fallback KIS" };
}

function updateRoutePreview() {
  const text = $("queryInput").value;
  if (!text.trim()) {
    setTaskBadge(null);
    return;
  }
  const route = parseBtcTask(text);
  setTaskBadge(route.task, route.source);
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(apiUrl(path), { ...options, headers, cache: "no-store" });
  if (!response.ok) {
    const ct = response.headers.get("content-type") || "";
    let detail = "";
    if (ct.includes("application/json")) {
      try {
        const data = await response.json();
        detail = data.error || data.detail || data.message || JSON.stringify(data);
      } catch (_) {}
    } else {
      try {
        detail = (await response.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 260);
      } catch (_) {}
    }
    const error = new Error(`HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function requestJson(path, payload) {
  const response = await request(path, payload === undefined ? { method: "GET" } : {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function checkHealth({ fromChat = false } = {}) {
  if (!getApiBase()) {
    setHealth("bad", "Chưa nhập API Server.");
    if (fromChat) addMessage("assistant", "Chưa có API Server để kiểm tra.", { error: true, meta: nowTime() });
    return false;
  }

  setHealth("busy", "Đang kiểm tra /health…");
  const started = performance.now();
  try {
    const data = await requestJson("/health");
    const ms = Math.round(performance.now() - started);
    state.healthOk = true;
    state.apiBase = getApiBase();
    const build = data.build_version || data.version || data.status || "OK";
    const auth = data.auth_mode ? ` · auth ${data.auth_mode}` : "";
    setHealth("good", `ONLINE · ${build}${auth} · ${ms} ms`);
    if (fromChat) addMessage("assistant", `Server đang sống. /health = 200 (${ms} ms).`, { meta: nowTime() });
    return true;
  } catch (error) {
    state.healthOk = false;
    setHealth("bad", `OFFLINE · ${error.message}`);
    if (fromChat) addMessage("assistant", `Không kiểm tra được server: ${error.message}`, { error: true, meta: nowTime() });
    return false;
  }
}

function isGreeting(text) {
  return GREETINGS.has(foldText(text));
}

function isHealthRequest(text) {
  const f = foldText(text);
  return HEALTH_PHRASES.some((p) => f === foldText(p) || f.includes(foldText(p)));
}

function clearObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function resetPreviewObserver() {
  if (state.previewObserver) {
    state.previewObserver.disconnect();
    state.previewObserver = null;
  }
  state.previewQueued.clear();
  state.previewQueue.length = 0;
  state.previewActive = 0;
  state.previewLoaded = 0;
  state.previewFailed = 0;
}

function clearResults(reason = "") {
  clearObjectUrls();
  resetPreviewObserver();
  state.rawResponse = null;
  state.candidates = [];
  state.selectedIndex = -1;
  state.lightboxIndex = -1;
  $("candidateCount").textContent = "0";
  $("previewCount").textContent = "0/0";
  $("querySummary").textContent = reason || "Chưa có truy vấn.";
  $("selectedDetail").classList.add("hidden");
  const grid = $("candidateGrid");
  grid.classList.add("empty-grid");
  grid.innerHTML = '<div class="empty-state"><div class="empty-mark">+</div><div class="empty-title">Chưa có candidate</div><div class="empty-sub">Gửi query BTC ở khung chat bên trái.</div></div>';
  renderRecall();
}

function onServerInputChanged() {
  const next = getApiBase();
  if (next === state.apiBase) return;
  state.serverGeneration++;
  state.apiBase = next;
  state.healthOk = false;
  setHealth("idle", next ? "URL đã đổi · bấm CHECK" : "Chưa kiểm tra");
  clearResults(next ? "Server đã đổi. Gửi query mới sau khi CHECK." : "Chưa có API Server.");
}

function candidatePts(row) {
  for (const key of PTS_KEYS) {
    const n = safeNumber(row?.[key]);
    if (n !== null && n >= 0) return { value: n, source: key };
  }
  for (const [sKey, eKey] of INTERVAL_PAIRS) {
    const s = safeNumber(row?.[sKey]);
    const e = safeNumber(row?.[eKey]);
    if (s !== null && e !== null) return { value: (s + e) / 2, source: `midpoint(${sKey},${eKey})` };
    if (s !== null) return { value: s, source: sKey };
  }
  return { value: null, source: null };
}

function candidateFrame(row) {
  return row?.frame_ref_id || row?.best_frame_ref_id || row?.best_adaptive_frame_ref_id || row?.representative_frame_ref_id || row?.keyframe_id || row?.frame_id || null;
}

function candidateFrameIdx(row) {
  return row?.frame_idx_candidate ?? row?.frame_idx ?? null;
}

function candidateKeyframe(row) {
  return row?.keyframe_id ?? row?.frame_idx_candidate ?? row?.candidate_id ?? row?.interval_id ?? null;
}

function candidateScore(row) {
  const keys = [
    "raw_cosine", "local_visual_cosine", "semantic_score", "semantic_score_normalized_only",
    "federated_score_normalized_only", "path_score_normalized_only", "dual_view_fused_cosine",
    "score", "utility"
  ];
  for (const key of keys) {
    const n = safeNumber(row?.[key]);
    if (n !== null) return { key, value: n };
  }
  return null;
}

function inferCandidateTitle(row, path, rank) {
  if (row?.event_text) return String(row.event_text);
  if (row?.event_id !== undefined && row?.event_id !== null) return `Event ${row.event_id}`;
  if (row?.evidence_pack_id) return `Evidence ${row.evidence_pack_id}`;
  if (row?.rank !== undefined && row?.rank !== null) return `Rank #${row.rank}`;
  if (candidateFrame(row)) return String(candidateFrame(row));
  const tail = path.slice(-2).map(String).join(" / ");
  return tail || `Candidate ${rank}`;
}

function *walkResultNodes(obj, path = [], inheritedVideoId = null) {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const currentVideo = obj.video_id || inheritedVideoId;
    yield { row: obj, path, videoId: currentVideo };
    for (const [key, value] of Object.entries(obj)) {
      yield* walkResultNodes(value, [...path, key], currentVideo);
    }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      yield* walkResultNodes(obj[i], [...path, i], inheritedVideoId);
    }
  }
}

function normalizeCandidates(data, task) {
  const out = [];
  const seen = new Set();

  for (const { row, path, videoId } of walkResultNodes(data)) {
    if (!videoId) continue;
    const ptsInfo = candidatePts(row);
    const directImage = row.image_url || row.thumbnail_url || row.preview_url || null;
    if (ptsInfo.value === null && !directImage) continue;

    const frame = candidateFrame(row);
    const frameIdx = candidateFrameIdx(row);
    const candidateId = row.candidate_id || row.interval_id || row.evidence_pack_id || null;
    const key = [String(videoId), ptsInfo.value === null ? "" : ptsInfo.value.toFixed(3), frame || "", candidateId || ""].join("|");
    if (seen.has(key)) continue;
    seen.add(key);

    const rank = out.length + 1;
    out.push({
      id: `${task}-${rank}-${videoId}-${frame || ptsInfo.value || rank}`,
      rank,
      task,
      raw: row,
      title: inferCandidateTitle(row, path, rank),
      sourcePath: path,
      videoId: String(videoId),
      pts: ptsInfo.value,
      ptsSource: ptsInfo.source,
      frame,
      frameIdx,
      keyframe: candidateKeyframe(row),
      candidateId,
      evidencePackId: row.evidence_pack_id || null,
      eventId: row.event_id ?? null,
      eventIndex: row.event_index ?? null,
      eventText: row.event_text ?? null,
      relation: row.relation_from_prev ?? null,
      rawVideoRef: row.raw_video_ref ?? null,
      imageArtifactRef: row.image_artifact_ref ?? null,
      requestId: row.request_id ?? null,
      score: candidateScore(row),
      directImage,
      blobUrl: null,
      previewStatus: "idle",
    });

    if (out.length >= 100) break;
  }

  return out;
}

function candidateTimeLabel(c) {
  return c.pts === null ? "PTS —" : `${c.pts.toFixed(3)}s`;
}

function updatePreviewStats() {
  $("candidateCount").textContent = String(state.candidates.length);
  const done = state.previewLoaded + state.previewFailed;
  $("previewCount").textContent = `${state.previewLoaded}/${state.candidates.length}`;
  if (done === state.candidates.length && state.candidates.length) {
    $("previewCount").title = `${state.previewLoaded} loaded · ${state.previewFailed} failed`;
  }
}

function renderCandidates() {
  const grid = $("candidateGrid");
  grid.replaceChildren();
  grid.classList.remove("empty-grid");

  if (!state.candidates.length) {
    grid.classList.add("empty-grid");
    const box = document.createElement("div");
    box.className = "empty-state";
    box.innerHTML = '<div class="empty-mark">+</div><div class="empty-title">Không có candidate ảnh</div><div class="empty-sub">Backend response không có cặp video_id + timestamp có thể preview.</div>';
    grid.appendChild(box);
    updatePreviewStats();
    return;
  }

  const frag = document.createDocumentFragment();
  state.candidates.forEach((c, index) => {
    const card = document.createElement("article");
    card.className = "candidate-card";
    card.dataset.index = String(index);

    const imageWrap = document.createElement("div");
    imageWrap.className = "candidate-image-wrap";

    const img = document.createElement("img");
    img.className = "candidate-image";
    img.alt = `${c.videoId} @ ${candidateTimeLabel(c)}`;
    img.loading = "eager";
    img.draggable = false;

    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.textContent = "LOADING";

    const rank = document.createElement("div");
    rank.className = "candidate-rank";
    rank.textContent = `#${String(c.rank).padStart(2, "0")}`;

    const plus = document.createElement("div");
    plus.className = "candidate-plus";
    plus.textContent = "+";

    imageWrap.append(placeholder, img, rank, plus);

    const caption = document.createElement("div");
    caption.className = "candidate-caption";
    const video = document.createElement("div");
    video.className = "candidate-video";
    video.textContent = c.videoId;
    const time = document.createElement("div");
    time.className = "candidate-time";
    time.textContent = `${candidateTimeLabel(c)}${c.frameIdx !== null ? ` · frame ${c.frameIdx}` : ""}`;
    const source = document.createElement("div");
    source.className = "candidate-source";
    source.textContent = c.score ? `${c.score.key}=${c.score.value.toFixed(4)}` : c.ptsSource || "candidate";
    caption.append(video, time, source);

    card.append(imageWrap, caption);
    card.addEventListener("click", () => selectCandidate(index, { scroll: true }));
    card.addEventListener("dblclick", () => openLightbox(index));
    card._previewRefs = { index, img, placeholder };
    frag.appendChild(card);
  });

  grid.appendChild(frag);
  updatePreviewStats();
  primeCandidatePreviews();
}

function primeCandidatePreviews() {
  resetPreviewObserver();
  const grid = $("candidateGrid");
  const cards = [...grid.querySelectorAll(".candidate-card")];

  // Critical fix: load the first visible page immediately after search. Do not wait for
  // a later CHECK/focus/layout event to wake an IntersectionObserver.
  cards.slice(0, Math.min(24, cards.length)).forEach((card) => {
    const r = card._previewRefs;
    if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
  });

  if (!("IntersectionObserver" in window)) {
    cards.slice(24).forEach((card) => {
      const r = card._previewRefs;
      if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
    });
    return;
  }

  state.previewObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      const r = entry.target._previewRefs;
      if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
    }
  }, { root: grid, rootMargin: "520px 0px", threshold: 0.01 });

  cards.slice(24).forEach((card) => state.previewObserver.observe(card));
}

function queueCandidatePreview(index, img, placeholder) {
  if (state.previewQueued.has(index)) return;
  state.previewQueued.add(index);
  const c = state.candidates[index];
  if (!c) return;

  if (c.directImage) {
    c.previewStatus = "loading";
    img.src = c.directImage;
    img.onload = () => {
      c.previewStatus = "ready";
      state.previewLoaded++;
      img.classList.add("ready");
      placeholder.remove();
      updatePreviewStats();
      syncSelectedPreview(index);
    };
    img.onerror = () => {
      c.previewStatus = "failed";
      state.previewFailed++;
      placeholder.textContent = "NO IMAGE";
      updatePreviewStats();
    };
    return;
  }

  if (!c.videoId || c.videoId === "unknown" || c.pts === null) {
    c.previewStatus = "failed";
    state.previewFailed++;
    placeholder.textContent = "NO PTS";
    updatePreviewStats();
    return;
  }

  state.previewQueue.push({ index, img, placeholder, generation: state.serverGeneration });
  pumpPreviewQueue();
}

function pumpPreviewQueue() {
  while (state.previewActive < state.previewConcurrency && state.previewQueue.length) {
    const job = state.previewQueue.shift();
    state.previewActive++;
    loadPreview(job)
      .catch(() => {})
      .finally(() => {
        state.previewActive = Math.max(0, state.previewActive - 1);
        pumpPreviewQueue();
      });
  }
}

async function loadPreview({ index, img, placeholder, generation }) {
  const c = state.candidates[index];
  if (!c) return;
  c.previewStatus = "loading";
  try {
    const response = await request("/preview", {
      method: "POST",
      body: JSON.stringify({ video_id: c.videoId, pts_time: c.pts }),
    });
    if (generation !== state.serverGeneration) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    c.blobUrl = url;
    c.previewStatus = "ready";
    state.previewLoaded++;
    img.src = url;
    await img.decode().catch(() => {});
    img.classList.add("ready");
    placeholder.remove();
    updatePreviewStats();
    syncSelectedPreview(index);
  } catch (error) {
    if (generation !== state.serverGeneration) return;
    c.previewStatus = "failed";
    state.previewFailed++;
    placeholder.textContent = "NO IMAGE";
    placeholder.title = error.message;
    updatePreviewStats();
    syncSelectedPreview(index);
  }
}

function selectedCandidate() {
  return state.candidates[state.selectedIndex] || null;
}

function metaRow(key, value) {
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length)) return null;
  const k = document.createElement("div");
  k.className = "meta-key";
  k.textContent = key;
  const v = document.createElement("div");
  v.className = "meta-value";
  v.textContent = Array.isArray(value) ? value.join(" / ") : String(value);
  return [k, v];
}

function candidateMetaPairs(c) {
  return [
    ["video_id", c.videoId],
    ["pts_time", c.pts === null ? null : c.pts.toFixed(6)],
    ["pts_source", c.ptsSource],
    ["frame_ref_id", c.frame],
    ["frame_idx", c.frameIdx],
    ["keyframe", c.keyframe],
    ["candidate_id", c.candidateId],
    ["evidence_pack_id", c.evidencePackId],
    ["event_id", c.eventId],
    ["event_index", c.eventIndex],
    ["event_text", c.eventText],
    ["relation", c.relation],
    ["score", c.score ? `${c.score.key} = ${c.score.value.toFixed(6)}` : null],
    ["raw_video_ref", c.rawVideoRef],
    ["image_artifact_ref", c.imageArtifactRef],
    ["request_id", c.requestId],
    ["json_path", c.sourcePath],
  ];
}

function renderSelectedDetail(index, { scroll = false } = {}) {
  const c = state.candidates[index];
  if (!c) return;
  state.selectedIndex = index;
  document.querySelectorAll(".candidate-card").forEach((card, i) => card.classList.toggle("selected", i === index));

  $("selectedDetail").classList.remove("hidden");
  $("selectedTitle").textContent = `#${c.rank} · ${c.title}`;
  $("selectedSub").textContent = `${c.videoId} · ${candidateTimeLabel(c)}${c.frameIdx !== null ? ` · frame ${c.frameIdx}` : ""}`;
  $("selectedRawJson").textContent = JSON.stringify(c.raw, null, 2);

  const meta = $("selectedMeta");
  meta.replaceChildren();
  for (const [key, value] of candidateMetaPairs(c)) {
    const pair = metaRow(key, value);
    if (pair) meta.append(...pair);
  }

  syncSelectedPreview(index);
  if (c.previewStatus === "idle") {
    const card = document.querySelector(`.candidate-card[data-index="${index}"]`);
    const r = card?._previewRefs;
    if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
  }

  if (scroll) {
    $("selectedDetail").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function syncSelectedPreview(index) {
  if (state.selectedIndex !== index) return;
  const c = state.candidates[index];
  if (!c) return;
  const img = $("selectedPreview");
  const placeholder = $("selectedPreviewPlaceholder");
  img.classList.remove("ready");
  img.removeAttribute("src");
  placeholder.style.display = "grid";
  placeholder.textContent = c.previewStatus === "failed" ? "NO IMAGE" : "PREVIEW";
  const src = c.blobUrl || c.directImage;
  if (src) {
    img.src = src;
    img.onload = () => {
      img.classList.add("ready");
      placeholder.style.display = "none";
    };
  }
}

function selectCandidate(index, options = {}) {
  renderSelectedDetail(index, options);
}

async function copyText(value, label) {
  const text = value === null || value === undefined ? "" : String(value);
  try {
    await navigator.clipboard.writeText(text);
    addMessage("assistant", `Đã copy ${label}.`, { meta: nowTime() });
  } catch (_) {
    window.prompt(`Copy ${label}:`, text);
  }
}

function bindSelectedActions() {
  $("copyVideoButton").addEventListener("click", () => {
    const c = selectedCandidate();
    if (c) copyText(c.videoId, "video_id");
  });
  $("copyFrameButton").addEventListener("click", () => {
    const c = selectedCandidate();
    if (c) copyText(c.frame || c.frameIdx || "", "frame");
  });
  $("copyPtsButton").addEventListener("click", () => {
    const c = selectedCandidate();
    if (c) copyText(`${c.videoId} @ ${c.pts === null ? "N/A" : c.pts.toFixed(6)}s`, "video@pts");
  });
  $("copyJsonButton").addEventListener("click", () => {
    const c = selectedCandidate();
    if (c) copyText(JSON.stringify(c.raw, null, 2), "JSON");
  });
  $("openLightboxButton").addEventListener("click", () => {
    if (state.selectedIndex >= 0) openLightbox(state.selectedIndex);
  });
}

function getActiveResult(data) {
  return data?.active_result?.payload || data?.active_result || data?.result?.active_result?.payload || null;
}

function rawTopKScore(data, k) {
  const containers = [data?.official_scoring, data?.official_metrics, data?.metrics, data?.scoring, data?.score].filter((x) => x && typeof x === "object");
  const keys = [`R@${k}`, `r@${k}`, `r_at_${k}`, `top_${k}_r_score`, `top${k}`];
  for (const obj of containers) {
    for (const key of keys) {
      const n = safeNumber(obj?.[key]);
      if (n !== null && n >= 0 && n <= 1) return n;
    }
  }
  for (const key of keys) {
    const n = safeNumber(data?.[key]);
    if (n !== null && n >= 0 && n <= 1) return n;
  }
  return null;
}

function rawFinalBtcScore(data) {
  const candidates = [
    data?.official_scoring?.final_score,
    data?.official_scoring?.mean_topk_r_score,
    data?.official_metrics?.final_score,
    data?.metrics?.final_score,
    data?.final_score,
  ];
  for (const value of candidates) {
    const n = safeNumber(value);
    if (n !== null && n >= 0 && n <= 1) return n;
  }
  return null;
}

function explicitRScore(raw) {
  for (const key of ["r_score", "rscore", "R-Score", "R_Score", "official_r_score", "official_rscore"]) {
    const n = safeNumber(raw?.[key]);
    if (n !== null && n >= 0 && n <= 1) return n;
  }
  return null;
}

function scoringAnswerRows(data) {
  const active = getActiveResult(data) || {};
  const sources = [
    data?.submission_candidates, data?.scoring_answers, data?.official_answers, data?.answers,
    active?.submission_candidates, active?.scoring_answers, active?.official_answers,
  ];
  for (const rows of sources) {
    if (Array.isArray(rows) && rows.length) return rows.slice(0, 100);
  }
  if (state.currentTask === "KIS" && state.candidates.length) {
    const rows = state.candidates.map((c) => c.raw);
    if (rows.every((r) => explicitRScore(r) !== null)) return rows.slice(0, 100);
  }
  return [];
}

function computeBtcTopK(k) {
  const backend = rawTopKScore(state.rawResponse, k);
  if (backend !== null) return { value: backend, source: "backend official metric", count: null };
  const rows = scoringAnswerRows(state.rawResponse);
  if (!rows.length) return null;
  const scores = rows.map(explicitRScore);
  if (scores.some((x) => x === null)) return null;
  const used = scores.slice(0, Math.min(k, scores.length));
  if (!used.length) return { value: 0, source: "0 submitted answers", count: 0 };
  return { value: Math.max(...used), source: `max official R-Score trong ${used.length} answers`, count: used.length };
}

function renderRecall() {
  const detail = $("recallDetail");
  detail.replaceChildren();
  const title = document.createElement("div");
  title.className = "recall-detail-title";
  title.textContent = "BTC R@K — OFFICIAL ONLY";
  detail.appendChild(title);

  if (!state.rawResponse) {
    const empty = document.createElement("div");
    empty.className = "recall-empty";
    empty.textContent = "Chưa có kết quả.";
    detail.appendChild(empty);
    $("officialScoreStatus").textContent = "Official R@K: cần GT";
    $("officialScoreStatus").classList.remove("ready");
    return;
  }

  const grid = document.createElement("div");
  grid.className = "recall-grid";
  const values = [];
  for (const k of BTC_SCORE_KS) {
    const result = computeBtcTopK(k);
    const cell = document.createElement("div");
    cell.className = "recall-cell";
    const strong = document.createElement("strong");
    strong.textContent = result ? `R@${k} = ${result.value.toFixed(4)}` : `R@${k} = —`;
    const desc = document.createElement("span");
    desc.textContent = result ? result.source : "không có GT / official R-Score";
    cell.append(strong, desc);
    grid.appendChild(cell);
    values.push(result?.value ?? null);
  }
  detail.appendChild(grid);

  const backendFinal = rawFinalBtcScore(state.rawResponse);
  const canAverage = values.every((v) => v !== null);
  const finalValue = backendFinal !== null ? backendFinal : (canAverage ? values.reduce((a, b) => a + b, 0) / BTC_SCORE_KS.length : null);

  const final = document.createElement("div");
  final.className = "btc-final-score";
  final.innerHTML = finalValue === null
    ? '<strong>OFFICIAL SCORE CHƯA CÓ</strong><span>Cần GT / official R-Score. Không thay bằng similarity.</span>'
    : `<strong>FINAL SCORE = ${finalValue.toFixed(4)}</strong><span>(R@1 + R@5 + R@20 + R@50 + R@100) / 5</span>`;
  detail.appendChild(final);

  const explain = document.createElement("div");
  explain.className = "recall-explain";
  explain.textContent = finalValue === null
    ? `Đây không phải lỗi UI. Live retrieval không có ground truth nên không thể tính R@K chính thức từ similarity score. Hiện có ${state.candidates.length} candidate records.`
    : `Official scoring đã có dữ liệu. Candidate records hiện tại: ${state.candidates.length}.`;
  detail.appendChild(explain);

  const top = $("officialScoreStatus");
  if (finalValue === null) {
    top.textContent = "Official R@K: chưa có GT";
    top.classList.remove("ready");
  } else {
    top.textContent = `Official score ${finalValue.toFixed(4)}`;
    top.classList.add("ready");
  }
}

function responseSummary(data, task) {
  const active = getActiveResult(data) || {};
  const bits = [`${task}`, `${state.candidates.length} image candidates`];
  if (active.query_id) bits.push(`query_id ${active.query_id}`);
  if (task === "TRAKE" && active.final_temporal_status) bits.push(active.final_temporal_status);
  if (task === "QA" && active.qa_status) bits.push(active.qa_status);
  if (active.verifier_pass === true) bits.push("verifier PASS");
  if (data?.query_json_file) bits.push("JSON saved on Kaggle");
  return bits.join(" · ");
}

async function runQuery(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw || state.busy) return;

  addMessage("user", raw, { meta: nowTime() });
  $("queryInput").value = "";
  updateRoutePreview();

  if (isGreeting(raw)) {
    addMessage("assistant", "Tôi là AIC Retrieval. Gửi query BTC để trả image candidates.", { meta: nowTime() });
    return;
  }
  if (isHealthRequest(raw)) {
    await checkHealth({ fromChat: true });
    return;
  }

  const route = parseBtcTask(raw);
  state.currentTask = route.task;
  state.currentQuery = route.query;
  setTaskBadge(route.task, route.source);

  if (!getApiBase()) {
    addMessage("assistant", "Chưa có API Server. Nhập URL ở ô trên rồi gửi lại query.", { error: true, meta: nowTime() });
    setHealth("bad", "Chưa nhập API Server.");
    return;
  }

  state.busy = true;
  $("sendButton").disabled = true;
  const pending = addMessage("assistant", `Đã nhận ${route.task}. Đang retrieve + load ảnh…`, { meta: `${route.source} · ${nowTime()}` });
  const started = performance.now();

  try {
    const data = await requestJson("/search", { task_type: route.task, query: route.query, top_k: 100 });
    const ms = Math.round(performance.now() - started);

    clearObjectUrls();
    resetPreviewObserver();
    state.rawResponse = data;
    state.candidates = normalizeCandidates(data, route.task);
    state.selectedIndex = -1;
    state.lightboxIndex = -1;

    $("querySummary").textContent = `${route.task} · ${route.query.replace(/\s+/g, " ")} · ${ms} ms`;
    renderCandidates();
    renderRecall();
    if (state.candidates.length) renderSelectedDetail(0, { scroll: false });

    pending.textContent = `Xong. ${responseSummary(data, route.task)}. Ảnh đang hiển thị bên phải.`;
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = `${ms} ms · ${nowTime()}`;
    pending.appendChild(meta);
    state.healthOk = true;
    setHealth("good", `ONLINE · search ${ms} ms`);
  } catch (error) {
    pending.classList.add("error");
    pending.textContent = `Search lỗi: ${error.message}`;
    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = nowTime();
    pending.appendChild(meta);
  } finally {
    state.busy = false;
    $("sendButton").disabled = false;
    $("queryInput").focus();
  }
}

function lightboxCandidate() {
  return state.candidates[state.lightboxIndex] || null;
}

function resetZoom() {
  state.zoom.scale = 1;
  state.zoom.x = 0;
  state.zoom.y = 0;
  applyZoom();
}

function applyZoom() {
  $("lightboxImage").style.transform = `translate(${state.zoom.x}px, ${state.zoom.y}px) scale(${state.zoom.scale})`;
}

function openLightbox(index) {
  state.lightboxIndex = index;
  $("lightbox").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  updateLightbox();
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  document.body.style.overflow = "";
  state.lightboxIndex = -1;
  resetZoom();
}

async function ensureLightboxImage(c) {
  if (c.blobUrl || c.directImage) return c.blobUrl || c.directImage;
  if (!c.videoId || c.pts === null) return "";
  const response = await request("/preview", {
    method: "POST",
    body: JSON.stringify({ video_id: c.videoId, pts_time: c.pts }),
  });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  c.blobUrl = url;
  return url;
}

async function updateLightbox() {
  const c = lightboxCandidate();
  if (!c) return;
  resetZoom();
  const img = $("lightboxImage");
  img.removeAttribute("src");
  $("lightboxMeta").textContent = `#${c.rank} · ${c.videoId} · ${candidateTimeLabel(c)} · frame ${c.frame || c.frameIdx || "—"} · ${c.ptsSource || "PTS"}`;
  try {
    const src = await ensureLightboxImage(c);
    if (src) img.src = src;
  } catch (error) {
    $("lightboxMeta").textContent += ` · preview lỗi: ${error.message}`;
  }
}

function moveLightbox(delta) {
  if (!state.candidates.length) return;
  state.lightboxIndex = (state.lightboxIndex + delta + state.candidates.length) % state.candidates.length;
  updateLightbox();
}

function initLightboxPanZoom() {
  const stage = $("lightboxStage");
  stage.addEventListener("wheel", (event) => {
    if ($("lightbox").classList.contains("hidden")) return;
    event.preventDefault();
    const next = Math.min(5, Math.max(1, state.zoom.scale * (event.deltaY < 0 ? 1.14 : 0.88)));
    state.zoom.scale = next;
    if (next === 1) { state.zoom.x = 0; state.zoom.y = 0; }
    applyZoom();
  }, { passive: false });

  stage.addEventListener("pointerdown", (event) => {
    if (state.zoom.scale <= 1) return;
    state.zoom.dragging = true;
    state.zoom.sx = event.clientX;
    state.zoom.sy = event.clientY;
    state.zoom.ox = state.zoom.x;
    state.zoom.oy = state.zoom.y;
    stage.classList.add("dragging");
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!state.zoom.dragging) return;
    state.zoom.x = state.zoom.ox + (event.clientX - state.zoom.sx);
    state.zoom.y = state.zoom.oy + (event.clientY - state.zoom.sy);
    applyZoom();
  });
  const finish = () => { state.zoom.dragging = false; stage.classList.remove("dragging"); };
  stage.addEventListener("pointerup", finish);
  stage.addEventListener("pointercancel", finish);
}

function init() {
  const params = new URLSearchParams(location.search);
  const api = params.get("api");
  if (api) {
    $("apiServer").value = api;
    state.apiBase = getApiBase();
  }

  $("healthButton").addEventListener("click", () => checkHealth());
  $("sendButton").addEventListener("click", () => runQuery($("queryInput").value));
  $("queryInput").addEventListener("input", updateRoutePreview);
  $("queryInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runQuery($("queryInput").value);
    }
  });
  $("apiServer").addEventListener("input", onServerInputChanged);
  $("apiServer").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); checkHealth(); }
  });

  bindSelectedActions();
  $("lightboxClose").addEventListener("click", closeLightbox);
  $("lightboxPrev").addEventListener("click", () => moveLightbox(-1));
  $("lightboxNext").addEventListener("click", () => moveLightbox(1));
  $("lightbox").addEventListener("click", (event) => {
    if (event.target === $("lightbox")) closeLightbox();
  });
  document.addEventListener("keydown", (event) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (event.key === "Escape") closeLightbox();
    if (event.key === "ArrowLeft") moveLightbox(-1);
    if (event.key === "ArrowRight") moveLightbox(1);
  });
  initLightboxPanZoom();

  clearResults();
  addMessage("assistant", "AIC Retrieval sẵn sàng. Enter query → ảnh xuất ngay bên phải. Shift+Enter để xuống dòng.", { meta: nowTime() });
  if (api) checkHealth();
  $("queryInput").focus();
}

document.addEventListener("DOMContentLoaded", init);

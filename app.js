"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  apiBase: "",
  serverToken: "",
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
  previewConcurrency: 4,
  previewQueued: new Set(),
  previewObserver: null,
  zoom: { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 },
};

const GREETINGS = new Set([
  "hi", "hello", "hey", "xin chao", "xin chào", "chao", "chào",
  "alo", "hello there", "good morning", "good afternoon", "good evening"
]);

const HEALTH_PHRASES = [
  "health", "check server", "server?", "server còn sống không", "server con song khong",
  "kiểm tra server", "kiem tra server", "ping server", "server status", "status server"
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
  $("routeHint").textContent = task
    ? `${task} · ${source || "detected"}`
    : "BTC task auto-route";
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
    return {
      task,
      query: firstLineHasTitle ? lines.slice(1).join("\n").trim() || original : original,
      source: "BTC title",
    };
  }

  // Structural fallback only. The UI labels this explicitly as inference.
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

async function request(path, options = {}, retryAuth = true) {
  const headers = new Headers(options.headers || {});
  if (!headers.has("Content-Type") && options.body && !(options.body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }
  if (state.serverToken) headers.set("Authorization", `Bearer ${state.serverToken}`);

  const response = await fetch(apiUrl(path), { ...options, headers, cache: "no-store" });
  if (response.status === 401 && retryAuth) {
    const token = window.prompt("Server yêu cầu Bearer token. Dán server_token.txt (chỉ giữ trong tab này):", "");
    if (token && token.trim()) {
      state.serverToken = token.trim();
      return request(path, options, false);
    }
  }

  if (!response.ok) {
    const ct = response.headers.get("content-type") || "";
    let detail = "";
    if (ct.includes("application/json")) {
      try {
        const data = await response.json();
        detail = data.error || data.detail || data.message || JSON.stringify(data);
      } catch (_) {}
    } else {
      try { detail = (await response.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 220); } catch (_) {}
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
    const build = data.build_version || data.version || data.status || "OK";
    setHealth("good", `ONLINE · ${build} · ${ms} ms`);
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

function getActiveResult(data) {
  return data?.active_result?.payload || data?.active_result || data?.result?.active_result?.payload || null;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function candidatePts(row) {
  for (const key of ["actual_pts_time", "pts_time", "pts_time_technical", "target_pts_time"]) {
    const n = safeNumber(row?.[key]);
    if (n !== null && n >= 0) return n;
  }
  const s = safeNumber(row?.start_pts_time_technical ?? row?.start_pts_time);
  const e = safeNumber(row?.end_pts_time_technical ?? row?.end_pts_time);
  if (s !== null && e !== null) return (s + e) / 2;
  if (s !== null) return s;
  return null;
}

function candidateFrame(row) {
  return row?.frame_ref_id || row?.best_frame_ref_id || row?.best_adaptive_frame_ref_id || row?.keyframe_id || row?.frame_id || null;
}

function candidateKeyframe(row) {
  return row?.keyframe_id ?? row?.frame_idx_candidate ?? row?.candidate_id ?? row?.interval_id ?? null;
}

function candidateScore(row) {
  const keys = [
    "raw_cosine", "semantic_score", "semantic_score_normalized_only", "federated_score_normalized_only",
    "path_score_normalized_only", "dual_view_fused_cosine", "score"
  ];
  for (const key of keys) {
    const n = safeNumber(row?.[key]);
    if (n !== null) return { key, value: n };
  }
  return null;
}

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    if (!row || typeof row !== "object") continue;
    const key = [row.video_id, candidateFrame(row), candidatePts(row), row.interval_id, row.candidate_id].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function normalizeCandidates(data, task) {
  const active = getActiveResult(data) || {};
  let rows = [];

  if (task === "KIS") {
    rows = Array.isArray(active.results) ? active.results : [];
  } else if (task === "TRAKE") {
    const refined = Array.isArray(active.refined_events) ? active.refined_events : [];
    const path = Array.isArray(active.path) ? active.path : [];
    const evidence = Array.isArray(active.event_evidence_top20)
      ? active.event_evidence_top20.flatMap((group, eventIndex) =>
          (Array.isArray(group) ? group : []).map((x) => ({ ...x, event_index: x.event_index ?? eventIndex })))
      : [];
    rows = dedupeRows([...refined, ...path, ...evidence]);
  } else if (task === "QA") {
    rows = Array.isArray(active.evidence_top20) ? active.evidence_top20 : [];
  }

  if (!rows.length) {
    for (const key of ["results", "candidates", "items", "hits", "evidence_top20"]) {
      if (Array.isArray(data?.[key])) { rows = data[key]; break; }
    }
  }

  return dedupeRows(rows).slice(0, 100).map((raw, i) => ({
    id: `${task}-${i}-${raw.video_id || "video"}-${candidateFrame(raw) || candidatePts(raw) || i}`,
    rank: i + 1,
    task,
    raw,
    videoId: String(raw.video_id || raw.video || "unknown"),
    pts: candidatePts(raw),
    frame: candidateFrame(raw),
    keyframe: candidateKeyframe(raw),
    score: candidateScore(raw),
    directImage: raw.image_url || raw.thumbnail_url || raw.preview_url || null,
    blobUrl: null,
  }));
}

function clearObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

function candidateTimeLabel(c) {
  return c.pts === null ? "PTS —" : `${c.pts.toFixed(3)}s`;
}

function makeInfoRow(key, value) {
  const row = document.createElement("div");
  row.className = "info-row";
  const k = document.createElement("div");
  k.className = "info-key";
  k.textContent = key;
  const v = document.createElement("div");
  v.className = "info-value";
  v.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  row.append(k, v);
  return row;
}

function renderCandidates() {
  const grid = $("candidateGrid");
  grid.replaceChildren();
  grid.classList.remove("empty-grid");

  if (!state.candidates.length) {
    grid.classList.add("empty-grid");
    const box = document.createElement("div");
    box.className = "empty-state";
    box.innerHTML = '<div class="empty-mark">+</div><div class="empty-title">Không có candidate</div><div class="empty-sub">Backend không trả candidate có thể hiển thị.</div>';
    grid.appendChild(box);
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
    img.loading = "lazy";
    img.draggable = false;

    const placeholder = document.createElement("div");
    placeholder.className = "image-placeholder";
    placeholder.textContent = "PREVIEW";

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
    time.textContent = candidateTimeLabel(c);
    caption.append(video, time);

    const info = document.createElement("div");
    info.className = "candidate-info";
    info.append(
      makeInfoRow("video", c.videoId),
      makeInfoRow("frame", c.frame),
      makeInfoRow("keyframe", c.keyframe),
      makeInfoRow("pts", c.pts === null ? null : c.pts.toFixed(6)),
      makeInfoRow("score", c.score ? `${c.score.key} = ${c.score.value.toFixed(6)}` : null)
    );

    card.append(imageWrap, caption, info);
    card.addEventListener("click", () => handleCandidateClick(index));
    frag.appendChild(card);

    // IMPORTANT: do not decode/fetch every preview immediately.  The full ranked
    // candidate metadata can exist in memory (up to 100 answers), while image bytes
    // are fetched only when a card is visible/near-visible.  R@100 never depends on
    // whether the browser downloaded the thumbnail.
    card._previewRefs = { index, img, placeholder };
  });
  grid.appendChild(frag);
  observeCandidatePreviews();
}

function handleCandidateClick(index) {
  const cards = [...document.querySelectorAll(".candidate-card")];
  if (state.selectedIndex !== index) {
    state.selectedIndex = index;
    cards.forEach((card, i) => card.classList.toggle("selected", i === index));
    return;
  }
  openLightbox(index);
}

function resetPreviewObserver() {
  if (state.previewObserver) {
    state.previewObserver.disconnect();
    state.previewObserver = null;
  }
  state.previewQueued.clear();
}

function observeCandidatePreviews() {
  resetPreviewObserver();
  const grid = $("candidateGrid");
  const cards = [...grid.querySelectorAll(".candidate-card")];

  // Fallback for very old browsers: still bound the initial work instead of
  // hammering /preview 100 times.
  if (!("IntersectionObserver" in window)) {
    cards.slice(0, 21).forEach((card) => {
      const r = card._previewRefs;
      if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
    });
    return;
  }

  state.previewObserver = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      observer.unobserve(card);
      const r = card._previewRefs;
      if (r) queueCandidatePreview(r.index, r.img, r.placeholder);
    }
  }, {
    root: grid,
    // Preload roughly 1-2 rows before the user reaches them.
    rootMargin: "420px 0px",
    threshold: 0.01,
  });

  cards.forEach((card) => state.previewObserver.observe(card));
}

function queueCandidatePreview(index, img, placeholder) {
  if (state.previewQueued.has(index)) return;
  state.previewQueued.add(index);
  const c = state.candidates[index];
  if (c.directImage) {
    img.src = c.directImage;
    img.onload = () => { img.classList.add("ready"); placeholder.remove(); };
    img.onerror = () => { placeholder.textContent = "NO IMAGE"; };
    return;
  }
  if (!c.videoId || c.videoId === "unknown" || c.pts === null) {
    placeholder.textContent = "NO PTS";
    return;
  }
  state.previewQueue.push({ index, img, placeholder });
  pumpPreviewQueue();
}

function pumpPreviewQueue() {
  while (state.previewActive < state.previewConcurrency && state.previewQueue.length) {
    const job = state.previewQueue.shift();
    state.previewActive++;
    loadPreview(job)
      .catch(() => {})
      .finally(() => {
        state.previewActive--;
        pumpPreviewQueue();
      });
  }
}

async function loadPreview({ index, img, placeholder }) {
  const c = state.candidates[index];
  try {
    const response = await request("/preview", {
      method: "POST",
      body: JSON.stringify({ video_id: c.videoId, pts_time: c.pts }),
    });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    c.blobUrl = url;
    img.src = url;
    await img.decode().catch(() => {});
    img.classList.add("ready");
    placeholder.remove();
  } catch (error) {
    placeholder.textContent = error.status === 401 ? "TOKEN" : "NO IMAGE";
    placeholder.title = error.message;
  }
}

const BTC_SCORE_KS = [1, 5, 20, 50, 100];

function rawTopKScore(data, k) {
  const containers = [
    data?.official_scoring,
    data?.official_metrics,
    data?.metrics,
    data?.scoring,
    data?.score,
  ].filter((x) => x && typeof x === "object");
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
    data?.submission_candidates,
    data?.scoring_answers,
    data?.official_answers,
    data?.answers,
    active?.submission_candidates,
    active?.scoring_answers,
    active?.official_answers,
  ];
  for (const rows of sources) {
    if (Array.isArray(rows) && rows.length) return rows.slice(0, 100);
  }

  // KIS cards can be scoring answers only when the backend explicitly attaches an
  // official R-Score to each row.  TRAKE evidence frames are NOT answer candidates:
  // one TRAKE answer is a complete N-frame temporal path.
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

  // BTC: R@k is the BEST individual R-Score among the first k submitted answers.
  // If fewer than k answers are submitted, missing slots cannot improve the max.
  const used = scores.slice(0, Math.min(k, scores.length));
  if (!used.length) return { value: 0, source: "0 submitted answers", count: 0 };
  return {
    value: Math.max(...used),
    source: `max R-Score trong ${used.length} câu trả lời đầu`,
    count: used.length,
  };
}

function renderRecall() {
  const detail = $("recallDetail");
  detail.replaceChildren();

  const title = document.createElement("div");
  title.className = "recall-detail-title";
  title.textContent = "BTC R@K — CHI TIẾT";
  detail.appendChild(title);

  if (!state.rawResponse) {
    const empty = document.createElement("div");
    empty.className = "recall-empty";
    empty.textContent = "Chưa có kết quả để tính.";
    detail.appendChild(empty);
    $("recallTopStatus").textContent = "Live không có GT → N/A. Không dùng similarity score thay R-Score.";
    return;
  }

  const grid = document.createElement("div");
  grid.className = "recall-grid official-score-grid";
  const values = [];

  for (const k of BTC_SCORE_KS) {
    const result = computeBtcTopK(k);
    const cell = document.createElement("div");
    cell.className = "recall-cell";
    const strong = document.createElement("strong");
    strong.textContent = result ? `R@${k} = ${result.value.toFixed(4)}` : `R@${k} = N/A`;
    const desc = document.createElement("span");
    desc.textContent = result ? result.source : "cần official R-Score / GT scorer";
    cell.append(strong, desc);
    grid.appendChild(cell);
    values.push(result?.value ?? null);
  }
  detail.appendChild(grid);

  const backendFinal = rawFinalBtcScore(state.rawResponse);
  const canAverage = values.every((v) => v !== null);
  const finalValue = backendFinal !== null
    ? backendFinal
    : (canAverage ? values.reduce((a, b) => a + b, 0) / BTC_SCORE_KS.length : null);

  const final = document.createElement("div");
  final.className = "btc-final-score";
  final.innerHTML = finalValue === null
    ? '<strong>FINAL SCORE = N/A</strong><span>=(R@1 + R@5 + R@20 + R@50 + R@100) / 5</span>'
    : `<strong>FINAL SCORE = ${finalValue.toFixed(4)}</strong><span>=(R@1 + R@5 + R@20 + R@50 + R@100) / 5</span>`;
  detail.appendChild(final);

  const explain = document.createElement("div");
  explain.className = "recall-explain";
  const n = state.candidates.length;
  const coverage = n >= 100
    ? `Backend/UI đang giữ ${Math.min(n, 100)}/100 candidate records.`
    : `Backend hiện trả ${n} candidate records; chưa có đủ 100 để kiểm tra toàn bộ Top-100.`;
  explain.textContent =
    `BTC không dùng Recall = hits/GT. R@k = max_{1≤i≤k}{R-Score(rᵢ)}. ` +
    `KIS/QA có R-Score nhị phân 0/1; TRAKE có thể nhận giá trị phân số theo số moment khớp. ${coverage}`;
  detail.appendChild(explain);

  $("recallTopStatus").textContent = finalValue === null
    ? `${n}/100 candidate records · scoring cần GT/official R-Score.`
    : `Final ${finalValue.toFixed(4)} · ${n}/100 candidate records.`;
}

function responseSummary(data, task) {
  const active = getActiveResult(data) || {};
  const bits = [`${task}`, `${state.candidates.length} candidates`];
  if (active.query_id) bits.push(`query_id ${active.query_id}`);
  if (task === "TRAKE" && active.final_temporal_status) bits.push(active.final_temporal_status);
  if (task === "QA" && active.qa_status) bits.push(active.qa_status);
  if (active.verifier_pass === true) bits.push("verifier PASS");
  return bits.join(" · ");
}

async function runQuery(rawText) {
  const raw = String(rawText || "").trim();
  if (!raw || state.busy) return;

  addMessage("user", raw, { meta: nowTime() });
  $("queryInput").value = "";
  updateRoutePreview();

  if (isGreeting(raw)) {
    addMessage("assistant", "Tôi là AIC Retrieval. Gửi query BTC để tự nhận KIS, TRAKE hoặc QA và trả candidates.", { meta: nowTime() });
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
  const pending = addMessage("assistant", `Đã nhận ${route.task}. Đang tìm candidates…`, { meta: `${route.source} · ${nowTime()}` });
  const started = performance.now();

  try {
    const data = await requestJson("/search", {
      task_type: route.task,
      query: route.query,
      // Forward-compatible request. Current v0.5.5 ignores this field and is still
      // hard-limited server-side; future server versions can honor it directly.
      top_k: 100,
    });
    const ms = Math.round(performance.now() - started);

    clearObjectUrls();
    resetPreviewObserver();
    state.previewQueue.length = 0;
    state.previewQueued.clear();
    state.rawResponse = data;
    state.candidates = normalizeCandidates(data, route.task);
    state.selectedIndex = -1;
    state.lightboxIndex = -1;

    $("querySummary").textContent = `${route.task} · ${route.query.replace(/\s+/g, " ")} · ${ms} ms`;
    renderCandidates();
    renderRecall();

    pending.textContent = `Xong. ${responseSummary(data, route.task)}.`;
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
    if (error.status === 401) setHealth("bad", "Server sống nhưng search cần token.");
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
  $("lightboxMeta").textContent = `#${c.rank} · ${c.videoId} · ${candidateTimeLabel(c)} · frame ${c.frame || "—"} · keyframe ${c.keyframe || "—"}`;
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
  if (api) $("apiServer").value = api;

  $("healthButton").addEventListener("click", () => checkHealth());
  $("sendButton").addEventListener("click", () => runQuery($("queryInput").value));
  $("queryInput").addEventListener("input", updateRoutePreview);
  $("queryInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runQuery($("queryInput").value);
    }
  });
  $("apiServer").addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); checkHealth(); }
  });

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

  addMessage("assistant", "AIC Retrieval sẵn sàng. Gửi query BTC hoặc hỏi “server còn sống không”.", { meta: nowTime() });
  if (api) checkHealth();
  $("queryInput").focus();
}

document.addEventListener("DOMContentLoaded", init);

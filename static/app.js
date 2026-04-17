const $ = (id) => document.getElementById(id);

const SESSIONS_KEY = "ollama-mempalace.sessions.v1";
const ACTIVE_KEY = "ollama-mempalace.activeSession";
const PREFS_KEY = "ollama-mempalace.prefs.v1";
const WING_PROMPT_KEY = "ollama-mempalace.wing_prompts.v1";
const KNOWN_WINGS_KEY = "ollama-mempalace.knownWings.v1";
const ONBOARDED_KEY = "ollama-mempalace.onboarded";

// Bump when defaults change. Resets behavior toggles to their declared defaults
// without nuking the rest of the user's prefs (model, wing, room, etc.).
const PREFS_DEFAULTS_VERSION = 2;

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function now() {
  return Date.now();
}

function loadJSON(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

const state = {
  sessions: loadJSON(SESSIONS_KEY, []),
  activeId: localStorage.getItem(ACTIVE_KEY) || null,
  prefs: loadJSON(PREFS_KEY, {
    model: "",
    wing: "personal",
    room: "general",
    recall: true,
    save: true,
    extract: true,
    identity: true,
    tools: false,
    showMemory: false,
    showAllWings: false,
  }),
  wingPrompts: loadJSON(WING_PROMPT_KEY, {}),
  knownWings: loadJSON(KNOWN_WINGS_KEY, ["personal"]),
  wings: [],
  models: [],
};

function rememberWing(name) {
  if (name && !state.knownWings.includes(name)) {
    state.knownWings.push(name);
    saveJSON(KNOWN_WINGS_KEY, state.knownWings);
  }
}

function forgetWing(name) {
  state.knownWings = state.knownWings.filter((w) => w !== name);
  saveJSON(KNOWN_WINGS_KEY, state.knownWings);
}

const els = {
  sidebar: $("sidebar"),
  toggleSidebar: $("toggle-sidebar"),
  showSidebar: $("show-sidebar"),
  newChat: $("new-chat"),
  newIncognito: $("new-incognito"),
  anonBanner: $("anon-banner"),
  openMemory: $("open-memory"),
  openSettings: $("open-settings"),
  sessions: $("sessions"),
  toggleWingFilter: $("toggle-wing-filter"),
  topbarWing: $("topbar-wing"),
  topbarWingNew: $("topbar-wing-new"),
  palaceLabel: $("palace-label"),
  emptyState: $("empty-state"),
  messages: $("messages"),
  chatArea: $("chat-area"),
  dragOverlay: $("drag-overlay"),
  dragWing: $("drag-wing"),
  attachStaging: $("attach-staging"),
  pendingAttachments: $("pending-attachments"),
  attachFileInput: $("attach-file-input"),
  wingFileInput: $("wing-file-input"),
  uploadWingFileBtn: $("upload-wing-file-btn"),
  attachmentsList: $("attachments-list"),
  wingPromptPicker: $("wing-prompt-picker"),
  input: $("input"),
  composer: $("composer"),
  send: $("send"),
  composerPlus: $("composer-plus"),
  composerRecall: $("composer-recall"),
  model: $("model"),
  toggleMemoryPane: $("toggle-memory-pane"),
  memoryPane: $("memory-pane"),
  closeMemory: $("close-memory"),
  hits: $("hits"),
  status: $("status"),
  settingsOverlay: $("settings-overlay"),
  closeSettings: $("close-settings"),
  identity: $("identity"),
  saveIdentity: $("save-identity"),
  resetIdentity: $("reset-identity"),
  identityStatus: $("identity-status"),
  wing: $("wing"),
  wingNew: $("wing-new"),
  wingRename: $("wing-rename"),
  wingDelete: $("wing-delete"),
  room: $("room"),
  wingPrompt: $("wing-prompt"),
  tRecall: $("t-recall"),
  tSave: $("t-save"),
  tExtract: $("t-extract"),
  tIdentity: $("t-identity"),
  tTools: $("t-tools"),
  refreshWakeup: $("refresh-wakeup"),
  wakeupTokens: $("wakeup-tokens"),
  wakeupText: $("wakeup-text"),
  memoryOverlay: $("memory-overlay"),
  closeMemoryModal: $("close-memory-modal"),
  statsContent: $("stats-content"),
  taxonomyContent: $("taxonomy-content"),
  recentContent: $("recent-content"),
  browserWing: $("browser-wing"),
  browserRoom: $("browser-room"),
  browserQ: $("browser-q"),
  browserReload: $("browser-reload"),
  browserList: $("browser-list"),
  browserPrev: $("browser-prev"),
  browserNext: $("browser-next"),
  browserPage: $("browser-page"),
};

function savePrefs() {
  state.prefs.model = els.model.value;
  state.prefs.wing = els.wing.value || state.prefs.wing;
  state.prefs.room = els.room.value || state.prefs.room;
  state.prefs.recall = els.tRecall.checked;
  state.prefs.save = els.tSave.checked;
  state.prefs.extract = els.tExtract.checked;
  state.prefs.identity = els.tIdentity.checked;
  if (els.tTools) state.prefs.tools = els.tTools.checked;
  saveJSON(PREFS_KEY, state.prefs);
  syncRecallButton();
}

function syncRecallButton() {
  // Default-on: only explicit `false` should make the button gray.
  const on = state.prefs.recall !== false;
  els.composerRecall.classList.toggle("on", on);
  const lbl = els.composerRecall.querySelector(".lbl");
  if (lbl) lbl.textContent = on ? "recall on" : "recall off";
  els.composerRecall.title = on
    ? "Memory recall is ON — the model gets relevant memories from this wing before each reply. Click to turn off."
    : "Memory recall is OFF — the model has no memory context. Click to turn on.";
}

function escapeHtml(s) {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `${kind} show`;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => els.status.classList.remove("show"), 4000);
}

/* ─── Sessions ─────────────────────────────────────────────────────────── */

function getActiveSession() {
  return state.sessions.find((s) => s.id === state.activeId);
}

function createSession(opts = {}) {
  const s = {
    id: uuid(),
    title: opts.anonymous ? "Incognito chat" : "New chat",
    wing: state.prefs.wing || "personal",
    room: state.prefs.room || "general",
    model: state.prefs.model || (state.models[0] ?? ""),
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    anonymous: !!opts.anonymous,
  };
  state.sessions.unshift(s);
  state.activeId = s.id;
  localStorage.setItem(ACTIVE_KEY, s.id);
  saveJSON(SESSIONS_KEY, state.sessions);
  return s;
}

const ANON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/></svg>`;

function deleteSession(id) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx < 0) return;
  state.sessions.splice(idx, 1);
  if (state.activeId === id) {
    state.activeId = state.sessions[0]?.id || null;
    localStorage.setItem(ACTIVE_KEY, state.activeId || "");
  }
  saveJSON(SESSIONS_KEY, state.sessions);
}

function setActive(id) {
  state.activeId = id;
  localStorage.setItem(ACTIVE_KEY, id);
  const s = getActiveSession();
  if (s) {
    if (s.model && state.models.includes(s.model)) els.model.value = s.model;
    if (s.wing) {
      ensureWingOption(s.wing);
      els.wing.value = s.wing;
    }
    if (s.room) els.room.value = s.room;
    state.prefs.wing = s.wing;
    state.prefs.room = s.room;
    state.prefs.model = s.model;
    saveJSON(PREFS_KEY, state.prefs);
    loadWingPromptForCurrent();
  }
  renderSessions();
  renderMessages();
}

function bucketSessionsByDate() {
  const today0 = new Date();
  const today = new Date(
    today0.getFullYear(),
    today0.getMonth(),
    today0.getDate(),
  ).getTime();
  const week = today - 6 * 86400000;
  const buckets = { Today: [], "This Week": [], Older: [] };
  const wing = state.prefs.wing || "personal";
  const showAll = !!state.prefs.showAllWings;
  for (const s of state.sessions) {
    if (!showAll && s.wing !== wing) continue;
    if (s.updatedAt >= today) buckets.Today.push(s);
    else if (s.updatedAt >= week) buckets["This Week"].push(s);
    else buckets.Older.push(s);
  }
  return buckets;
}

function syncWingFilter() {
  const lbl = els.toggleWingFilter.querySelector(".lbl");
  if (state.prefs.showAllWings) {
    lbl.textContent = "all wings";
    els.toggleWingFilter.classList.remove("filtered");
  } else {
    lbl.textContent = state.prefs.wing || "personal";
    els.toggleWingFilter.classList.add("filtered");
  }
}

function renderSessions() {
  els.sessions.innerHTML = "";
  const buckets = bucketSessionsByDate();
  for (const [label, group] of Object.entries(buckets)) {
    if (!group.length) continue;
    const groupEl = document.createElement("div");
    groupEl.className = "sessions-group";
    groupEl.innerHTML = `<div class="sessions-group-label">${label}</div>`;
    for (const s of group) {
      const item = document.createElement("div");
      item.className = `session-item${s.id === state.activeId ? " active" : ""}${s.anonymous ? " anon" : ""}`;
      const mark = s.anonymous
        ? `<span class="anon-mark" title="Incognito">${ANON_SVG}</span>`
        : "";
      item.innerHTML = `
        <span class="title">${mark}${escapeHtml(s.title || "Untitled")}</span>
        <span class="actions">
          <button class="session-btn rename" title="Rename">✎</button>
          <button class="session-btn delete" title="Delete">✕</button>
        </span>
      `;
      item.addEventListener("click", (e) => {
        if (e.target.classList.contains("session-btn")) return;
        setActive(s.id);
      });
      item.querySelector(".rename").addEventListener("click", (e) => {
        e.stopPropagation();
        const next = prompt("Rename chat:", s.title);
        if (!next) return;
        s.title = next.trim();
        s.updatedAt = now();
        saveJSON(SESSIONS_KEY, state.sessions);
        renderSessions();
      });
      item.querySelector(".delete").addEventListener("click", async (e) => {
        e.stopPropagation();
        const alsoMemory = confirm(
          `Delete chat "${s.title}"?\n\nOK = also delete its memory drawers\nCancel to abort`,
        );
        if (!alsoMemory) return;
        // Attempt to purge associated drawers. Failure is non-fatal.
        try {
          const r = await fetch(`/api/chat-session/${encodeURIComponent(s.id)}`, {
            method: "DELETE",
          });
          if (r.ok) {
            const d = await r.json();
            if (d.deleted) setStatus(`removed ${d.deleted} drawers`, "warn");
          }
        } catch {}
        deleteSession(s.id);
        renderSessions();
        renderMessages();
        if (!state.sessions.length) ensureSession();
      });
      groupEl.appendChild(item);
    }
    els.sessions.appendChild(groupEl);
  }
}

function ensureSession() {
  if (!getActiveSession()) {
    if (state.sessions.length) {
      state.activeId = state.sessions[0].id;
      localStorage.setItem(ACTIVE_KEY, state.activeId);
    } else {
      createSession();
    }
  }
  renderSessions();
}

/* ─── Messages ─────────────────────────────────────────────────────────── */

function renderMessages() {
  const s = getActiveSession();
  els.anonBanner.hidden = !(s && s.anonymous);
  if (!s || !s.messages.length) {
    els.emptyState.hidden = false;
    els.messages.hidden = true;
    els.messages.innerHTML = "";
    return;
  }
  els.emptyState.hidden = true;
  els.messages.hidden = false;
  els.messages.innerHTML = "";
  for (const m of s.messages) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    const shown =
      m.role === "user" && m.displayContent ? m.displayContent : m.content;
    const attachTag =
      m.attachments && m.attachments.length
        ? `<div class="msg-attachments">📎 ${m.attachments
            .map((a) => escapeHtml(a))
            .join(", ")}</div>`
        : "";
    const thinkingTag = m.thinking && m.thinking.trim()
      ? `<details class="msg-thinking" ${m.content ? "" : "open"}><summary>💭 thinking</summary><div class="thinking-body">${escapeHtml(m.thinking)}</div></details>`
      : "";
    const toolsTag =
      m.toolCalls && m.toolCalls.length
        ? `<div class="tool-calls">${m.toolCalls
            .map((tc) => {
              const argsStr =
                typeof tc.arguments === "string"
                  ? tc.arguments
                  : JSON.stringify(tc.arguments ?? {}, null, 2);
              const resultStr =
                tc.result === null
                  ? "…running"
                  : JSON.stringify(tc.result, null, 2);
              return `<details class="tool-chip"><summary>🔧 ${escapeHtml(tc.name)}</summary><pre>args: ${escapeHtml(argsStr)}\n\n→ ${escapeHtml(resultStr)}</pre></details>`;
            })
            .join("")}</div>`
        : "";
    div.innerHTML = `<span class="role">${m.role}</span>${thinkingTag}${toolsTag}${attachTag}${escapeHtml(shown)}`;
    if (m.extracted && m.extracted.length) {
      const ex = document.createElement("div");
      ex.className = "extracted";
      ex.innerHTML =
        `<b>extracted ${m.extracted.length} fact${m.extracted.length === 1 ? "" : "s"}:</b>` +
        `<ul>${m.extracted
          .map((f) => `<li>[${escapeHtml(f.type)}] ${escapeHtml(f.preview)}</li>`)
          .join("")}</ul>`;
      div.appendChild(ex);
    }
    els.messages.appendChild(div);
  }
  els.messages.parentElement.scrollTop = els.messages.parentElement.scrollHeight;
}

function renderHits(hits) {
  els.hits.innerHTML = "";
  if (!hits || !hits.length) {
    els.hits.innerHTML =
      '<div class="hit-empty">no memories pulled in for this turn</div>';
    return;
  }
  for (const h of hits) {
    const div = document.createElement("div");
    div.className = "hit";
    div.innerHTML = `
      <div class="hit-meta">
        <span>${escapeHtml(h.wing || "?")}/${escapeHtml(h.room || "?")}</span>
        <span>sim ${h.similarity ?? "?"}</span>
      </div>
      <div class="hit-text">${escapeHtml(h.preview || "")}</div>
    `;
    els.hits.appendChild(div);
  }
}

/* ─── Wings & models ───────────────────────────────────────────────────── */

async function loadModels() {
  try {
    const r = await fetch("/api/models");
    const data = await r.json();
    state.models = data.models || [];
    els.model.innerHTML = state.models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("");
    if (state.prefs.model && state.models.includes(state.prefs.model)) {
      els.model.value = state.prefs.model;
    }
  } catch (e) {
    setStatus(`models: ${e.message}`, "err");
  }
}

function populateWingSelect(select, desired) {
  // Union of wings the API knows about (have drawers) and wings the user
  // has created in this browser (no drawers yet but should still be selectable).
  const apiNames = new Set(state.wings.map((w) => w.name));
  const apiOpts = state.wings.map((w) => ({
    name: w.name,
    label: `${w.name} (${w.drawer_count})`,
  }));
  const knownOnlyOpts = state.knownWings
    .filter((n) => !apiNames.has(n))
    .map((n) => ({ name: n, label: `${n} (empty)` }));
  const all = [...apiOpts, ...knownOnlyOpts].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (desired && !all.some((o) => o.name === desired)) {
    all.unshift({ name: desired, label: `${desired} (new)` });
  }
  select.innerHTML = all
    .map(
      (o) =>
        `<option value="${escapeHtml(o.name)}">${escapeHtml(o.label)}</option>`,
    )
    .join("");
  if (desired) select.value = desired;
}

function ensureWingOption(name) {
  for (const sel of [els.wing, els.topbarWing]) {
    if (![...sel.options].some((o) => o.value === name)) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name} (new)`;
      sel.appendChild(opt);
    }
  }
}

async function loadWings(preferred) {
  try {
    const r = await fetch("/api/wings");
    const data = await r.json();
    state.wings = data.wings || [];
    // Any wing returned by the API is by definition known.
    for (const w of state.wings) rememberWing(w.name);
    const desired = preferred || state.prefs.wing || "personal";
    rememberWing(desired);
    populateWingSelect(els.wing, desired);
    populateWingSelect(els.topbarWing, desired);
  } catch (e) {
    setStatus(`wings: ${e.message}`, "err");
  }
}

function setCurrentWing(name) {
  ensureWingOption(name);
  els.wing.value = name;
  els.topbarWing.value = name;
  state.prefs.wing = name;
  const s = getActiveSession();
  if (s) s.wing = name;
  saveJSON(PREFS_KEY, state.prefs);
  saveJSON(SESSIONS_KEY, state.sessions);
  loadWingPromptForCurrent();
  loadWakeup();
  syncWingFilter();
  renderSessions();
}

function setCurrentRoom(name) {
  els.room.value = name;
  state.prefs.room = name;
  const s = getActiveSession();
  if (s) s.room = name;
  saveJSON(PREFS_KEY, state.prefs);
  saveJSON(SESSIONS_KEY, state.sessions);
}

function populateWingPromptPicker() {
  if (!els.wingPromptPicker) return;
  const seen = new Set();
  const names = [];
  for (const w of state.wings) {
    if (!seen.has(w.name)) {
      seen.add(w.name);
      names.push(w.name);
    }
  }
  for (const w of state.knownWings) {
    if (!seen.has(w)) {
      seen.add(w);
      names.push(w);
    }
  }
  names.sort();
  const current = els.wingPromptPicker.value || els.wing.value || "personal";
  els.wingPromptPicker.innerHTML = names
    .map(
      (n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`,
    )
    .join("");
  if (names.includes(current)) els.wingPromptPicker.value = current;
  else if (names.length) els.wingPromptPicker.value = names[0];
}

function promptTargetWing() {
  return (
    (els.wingPromptPicker && els.wingPromptPicker.value) ||
    els.wing.value ||
    "personal"
  );
}

function loadWingPromptForCurrent() {
  populateWingPromptPicker();
  if (!els.wingPromptPicker) return;
  if (els.wing && !els.wingPromptPicker.value)
    els.wingPromptPicker.value = els.wing.value;
  const w = promptTargetWing();
  els.wingPrompt.value = state.wingPrompts[w] || "";
}

function saveWingPromptForCurrent() {
  const w = promptTargetWing();
  if (!w) return;
  if (els.wingPrompt.value.trim()) {
    state.wingPrompts[w] = els.wingPrompt.value;
  } else {
    delete state.wingPrompts[w];
  }
  saveJSON(WING_PROMPT_KEY, state.wingPrompts);
}

/* ─── Identity / Wakeup ────────────────────────────────────────────────── */

const DEFAULT_IDENTITY = `I am a personal AI assistant for *your name*.
Traits: concise, direct, remembers what matters across conversations.
Tone: warm but not sycophantic. Skip throat-clearing and trailing summaries.
People: *your name* (the user).
`;

async function loadIdentity() {
  try {
    const r = await fetch("/api/identity");
    const data = await r.json();
    if (data.text && data.text.trim()) {
      els.identity.value = data.text;
      els.identityStatus.textContent = `loaded from ${data.path}`;
    } else {
      els.identity.value = DEFAULT_IDENTITY;
      els.identityStatus.textContent =
        "default shown (not saved) — edit and click Save to persist";
    }
  } catch (e) {
    els.identityStatus.textContent = `load failed: ${e.message}`;
  }
}

function resetIdentity() {
  els.identity.value = DEFAULT_IDENTITY;
  els.identityStatus.textContent = "reset (not saved) — click Save to persist";
}

async function saveIdentity() {
  els.identityStatus.textContent = "saving…";
  try {
    const r = await fetch("/api/identity", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: els.identity.value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || "failed");
    els.identityStatus.textContent = `saved (${data.bytes} B)`;
  } catch (e) {
    els.identityStatus.textContent = `error: ${e.message}`;
  }
}

async function loadWakeup() {
  els.wakeupText.textContent = "loading…";
  try {
    const r = await fetch(
      `/api/wakeup?wing=${encodeURIComponent(els.wing.value || "")}`,
    );
    const data = await r.json();
    els.wakeupText.textContent = data.text || "(empty)";
    els.wakeupTokens.textContent = `~${data.tokens_estimate || 0} tokens`;
  } catch (e) {
    els.wakeupText.textContent = `error: ${e.message}`;
  }
}

/* ─── Chat ─────────────────────────────────────────────────────────────── */

async function sendMessage(text) {
  let session = getActiveSession();
  if (!session) {
    session = createSession();
    renderSessions();
  }
  // Persist UI choices into the session so they don't drift.
  session.wing = els.wing.value || session.wing;
  session.room = els.room.value || session.room;
  session.model = els.model.value || session.model;

  // Fold any staged attachments into the user's message
  const preamble = buildAttachmentPreamble();
  const attachedNames = pendingAttachments.map((p) => p.name);
  const fullUserContent = preamble ? `${preamble}\n${text}` : text;

  const userMsg = {
    role: "user",
    content: fullUserContent,
    displayContent: text,
    attachments: attachedNames,
  };
  const asstMsg = { role: "assistant", content: "" };
  session.messages.push(userMsg, asstMsg);
  if (session.title === "New chat" || !session.title) {
    session.title = text.slice(0, 60);
  }
  session.updatedAt = now();
  saveJSON(SESSIONS_KEY, state.sessions);
  renderSessions();
  renderMessages();

  els.send.disabled = true;
  setStatus("…thinking", "");

  const body = {
    model: session.model,
    wing: session.wing,
    room: session.room,
    messages: session.messages.slice(0, -1),
    use_memory: session.anonymous ? false : state.prefs.recall,
    save_to_memory: session.anonymous ? false : state.prefs.save,
    auto_extract: session.anonymous ? false : state.prefs.extract,
    use_identity: state.prefs.identity,
    enable_tools: session.anonymous ? false : !!state.prefs.tools,
    system_prompt: session.anonymous
      ? null
      : state.wingPrompts[session.wing] || null,
    session_id: session.id,
  };

  let assistantText = "";
  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) {
      const errText = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${errText}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          let evt;
          try {
            evt = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (evt.type === "memory_hits") {
            renderHits(evt.hits);
            setStatus(
              `pulled ${evt.hits.length} memories from ${evt.wing}/${evt.room}`,
              "",
            );
          } else if (evt.type === "thinking") {
            asstMsg.thinking = (asstMsg.thinking || "") + evt.content;
            renderMessages();
          } else if (evt.type === "tool_call") {
            if (!asstMsg.toolCalls) asstMsg.toolCalls = [];
            asstMsg.toolCalls.push({
              name: evt.name,
              arguments: evt.arguments,
              result: null,
            });
            setStatus(`🔧 calling ${evt.name}…`, "");
            renderMessages();
          } else if (evt.type === "tool_result") {
            if (asstMsg.toolCalls && asstMsg.toolCalls.length) {
              for (let i = asstMsg.toolCalls.length - 1; i >= 0; i--) {
                if (
                  asstMsg.toolCalls[i].name === evt.name &&
                  asstMsg.toolCalls[i].result === null
                ) {
                  asstMsg.toolCalls[i].result = evt.result;
                  break;
                }
              }
            }
            renderMessages();
          } else if (evt.type === "token") {
            assistantText += evt.content;
            asstMsg.content = assistantText;
            renderMessages();
          } else if (evt.type === "done") {
            if (evt.extracted_facts && evt.extracted_facts.length) {
              asstMsg.extracted = evt.extracted_facts;
              setStatus(`saved + extracted ${evt.extracted_facts.length} facts`, "ok");
            } else if (evt.saved_drawer_id) {
              setStatus("saved to memory", "ok");
            } else if (evt.save_error) {
              setStatus(`save error: ${evt.save_error}`, "warn");
            } else {
              setStatus("done", "");
            }
            session.updatedAt = now();
            saveJSON(SESSIONS_KEY, state.sessions);
            renderMessages();
          } else if (evt.type === "error") {
            setStatus(`stream error: ${evt.message}`, "err");
          }
        }
      }
    }
  } catch (e) {
    setStatus(e.message, "err");
    asstMsg.content = assistantText || `[error: ${e.message}]`;
    renderMessages();
  } finally {
    els.send.disabled = false;
    // Clear staged attachments after the send (whether success or failure)
    pendingAttachments.length = 0;
    renderPendingAttachments();
    saveJSON(SESSIONS_KEY, state.sessions);
    loadWings(els.wing.value);
  }
}

/* ─── Wing operations ─────────────────────────────────────────────────── */

async function renameWing() {
  const old = els.wing.value;
  const next = prompt(`Rename wing "${old}" to:`, old);
  if (!next || next.trim() === old) return;
  setStatus(`renaming ${old} → ${next}…`, "");
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(old)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_name: next.trim() }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(`renamed ${data.renamed} drawers`, "ok");
    const newName = next.trim();
    forgetWing(old);
    rememberWing(newName);
    if (state.wingPrompts[old]) {
      state.wingPrompts[newName] = state.wingPrompts[old];
      delete state.wingPrompts[old];
      saveJSON(WING_PROMPT_KEY, state.wingPrompts);
    }
    for (const s of state.sessions) {
      if (s.wing === old) s.wing = newName;
    }
    saveJSON(SESSIONS_KEY, state.sessions);
    await loadWings(newName);
    setCurrentWing(newName);
    renderSessions();
  } catch (e) {
    setStatus(`rename failed: ${e.message}`, "err");
  }
}

async function deleteWing() {
  const name = els.wing.value;
  if (
    !confirm(
      `Delete wing "${name}" and ALL its drawers? Sessions stay but lose their memory.`,
    )
  )
    return;
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(`deleted ${data.deleted} drawers from ${name}`, "warn");
    forgetWing(name);
    delete state.wingPrompts[name];
    saveJSON(WING_PROMPT_KEY, state.wingPrompts);
    await loadWings("personal");
    setCurrentWing("personal");
  } catch (e) {
    setStatus(`delete failed: ${e.message}`, "err");
  }
}

/* ─── Event wiring ─────────────────────────────────────────────────────── */

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  els.input.style.height = "auto";
  savePrefs();
  sendMessage(text);
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + "px";
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && (e.metaKey || e.ctrlKey || true)) {
    if (e.shiftKey) return;
    e.preventDefault();
    els.composer.dispatchEvent(new Event("submit"));
  }
});

els.newChat.addEventListener("click", () => {
  createSession();
  renderSessions();
  renderMessages();
  renderHits([]);
  els.input.focus();
});

els.newIncognito.addEventListener("click", () => {
  createSession({ anonymous: true });
  renderSessions();
  renderMessages();
  renderHits([]);
  setStatus("incognito chat — won't recall or save", "warn");
  els.input.focus();
});

els.toggleWingFilter.addEventListener("click", () => {
  state.prefs.showAllWings = !state.prefs.showAllWings;
  saveJSON(PREFS_KEY, state.prefs);
  syncWingFilter();
  renderSessions();
});

els.composerRecall.addEventListener("click", () => {
  state.prefs.recall = !state.prefs.recall;
  els.tRecall.checked = state.prefs.recall;
  savePrefs();
});

els.toggleMemoryPane.addEventListener("click", () => {
  els.memoryPane.hidden = !els.memoryPane.hidden;
});
els.closeMemory.addEventListener("click", () => {
  els.memoryPane.hidden = true;
});

els.toggleSidebar.addEventListener("click", () => {
  document.body.classList.add("no-sidebar");
  els.sidebar.classList.add("hidden");
  els.showSidebar.classList.remove("hidden");
});
els.showSidebar.addEventListener("click", () => {
  document.body.classList.remove("no-sidebar");
  els.sidebar.classList.remove("hidden");
  els.showSidebar.classList.add("hidden");
});

els.openSettings.addEventListener("click", openSettings);
els.composerPlus.addEventListener("click", () => els.attachFileInput.click());
els.closeSettings.addEventListener("click", () => {
  els.settingsOverlay.hidden = true;
  saveWingPromptForCurrent();
});

els.settingsOverlay.addEventListener("click", (e) => {
  if (e.target === els.settingsOverlay) {
    els.settingsOverlay.hidden = true;
    saveWingPromptForCurrent();
  }
});

async function openSettings() {
  els.settingsOverlay.hidden = false;
  await loadIdentity();
  loadWingPromptForCurrent();
  loadWakeup();
  loadAttachments();
  loadAaak();
}

/* ─── Attachments ─────────────────────────────────────────────────────── */

function makeAttachChip(text, kind = "") {
  const chip = document.createElement("div");
  chip.className = `attach-chip ${kind}`;
  chip.textContent = text;
  els.attachStaging.appendChild(chip);
  els.attachStaging.hidden = false;
  return chip;
}

async function uploadAttachment(file) {
  const wing = state.prefs.wing || "personal";
  const chip = makeAttachChip(`uploading ${file.name}…`, "uploading");
  const fd = new FormData();
  fd.append("file", file);
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(wing)}/attach`, {
      method: "POST",
      body: fd,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    chip.textContent = `✓ ${file.name} → ${data.chunks} chunks in ${wing}`;
    chip.className = "attach-chip ok";
    setStatus(`attached ${file.name} (${data.chunks} chunks)`, "ok");
    rememberWing(wing);
    await loadWings(wing);
    if (!els.settingsOverlay.hidden) loadAttachments();
  } catch (e) {
    chip.textContent = `✗ ${file.name}: ${e.message}`;
    chip.className = "attach-chip err";
    setStatus(`attach failed: ${e.message}`, "err");
  }
  // Auto-dismiss successful chips after 6s
  setTimeout(() => {
    chip.remove();
    if (!els.attachStaging.children.length) els.attachStaging.hidden = true;
  }, 6000);
}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml",
  "py", "js", "jsx", "ts", "tsx", "html", "htm", "css", "scss", "less",
  "rs", "go", "java", "c", "cpp", "h", "hpp", "rb", "php", "sh", "bash",
  "zsh", "sql", "log", "conf", "ini", "toml", "xml", "tex", "rst", "vue",
  "svelte", "lua", "r", "kt", "swift", "dart", "ex", "exs", "elm",
]);

function isLikelyText(file) {
  const name = (file.name || "").toLowerCase();
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  return TEXT_EXTENSIONS.has(name.slice(i + 1));
}

async function walkEntry(entry, out) {
  if (!entry) return;
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file((file) => {
        out.push(file);
        resolve();
      }, resolve);
    });
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    return new Promise((resolve) => {
      const collected = [];
      const readBatch = () => {
        reader.readEntries(async (entries) => {
          if (!entries.length) {
            for (const e of collected) await walkEntry(e, out);
            resolve();
          } else {
            collected.push(...entries);
            readBatch();
          }
        }, resolve);
      };
      readBatch();
    });
  }
}

async function collectFromDataTransfer(dt) {
  if (dt.items && dt.items.length && dt.items[0].webkitGetAsEntry) {
    const all = [];
    const promises = [];
    for (const item of dt.items) {
      const entry = item.webkitGetAsEntry();
      promises.push(walkEntry(entry, all));
    }
    await Promise.all(promises);
    return all;
  }
  return Array.from(dt.files || []);
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList);
  const text = files.filter(isLikelyText);
  const skipped = files.length - text.length;
  if (skipped) {
    setStatus(`skipping ${skipped} non-text file(s)`, "warn");
  }
  for (const f of text) {
    await uploadAttachment(f);
  }
}

async function loadAttachments() {
  const wing = state.prefs.wing || "personal";
  if (!els.attachmentsList) return;
  els.attachmentsList.innerHTML = '<div class="attachment-empty">loading…</div>';
  try {
    const r = await fetch(
      `/api/wings/${encodeURIComponent(wing)}/attachments`,
    );
    const data = await r.json();
    els.attachmentsList.innerHTML = "";
    if (!data.attachments?.length) {
      els.attachmentsList.innerHTML =
        '<div class="attachment-empty">No files attached to this wing.</div>';
      return;
    }
    for (const a of data.attachments) {
      const row = document.createElement("div");
      row.className = "attachment-row";
      row.innerHTML = `
        <span>
          <span class="filename">${escapeHtml(a.filename)}</span>
          <span class="meta">${a.chunks} chunks</span>
        </span>
        <button class="danger" type="button">remove</button>
      `;
      row.querySelector("button").addEventListener("click", async () => {
        if (!confirm(`Remove ${a.filename} from wing "${wing}"?`)) return;
        try {
          const dr = await fetch(
            `/api/wings/${encodeURIComponent(wing)}/attachments?filename=${encodeURIComponent(a.filename)}`,
            { method: "DELETE" },
          );
          const dd = await dr.json();
          if (!dr.ok) throw new Error(dd.detail || "failed");
          setStatus(`removed ${a.filename} (${dd.deleted} chunks)`, "warn");
          await loadAttachments();
          await loadWings(wing);
        } catch (e) {
          setStatus(`remove failed: ${e.message}`, "err");
        }
      });
      els.attachmentsList.appendChild(row);
    }
  } catch (e) {
    els.attachmentsList.innerHTML = `<div class="attachment-empty">error: ${escapeHtml(e.message)}</div>`;
  }
}

/* ─── Pending (per-message) attachments ─────────────────────────────── */

const pendingAttachments = []; // { name, size, content }

const STAGE_MAX_BYTES = 5 * 1024 * 1024;

async function stageAttachment(file) {
  if (!isLikelyText(file)) {
    setStatus(`skipped ${file.name} (not text)`, "warn");
    return;
  }
  if (file.size > STAGE_MAX_BYTES) {
    setStatus(`skipped ${file.name} (>5MB)`, "warn");
    return;
  }
  try {
    const content = await file.text();
    pendingAttachments.push({ name: file.name, size: file.size, content });
    renderPendingAttachments();
  } catch (e) {
    setStatus(`failed to read ${file.name}: ${e.message}`, "err");
  }
}

async function stageMany(fileList) {
  for (const f of Array.from(fileList)) {
    await stageAttachment(f);
  }
}

function renderPendingAttachments() {
  const host = els.pendingAttachments;
  host.innerHTML = "";
  if (!pendingAttachments.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  pendingAttachments.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "pending-chip";
    chip.innerHTML = `
      <span>📎</span>
      <span class="fname">${escapeHtml(p.name)}</span>
      <span class="fsize">${(p.size / 1024).toFixed(1)} KB</span>
      <span class="x" title="remove">×</span>
    `;
    chip.querySelector(".x").addEventListener("click", () => {
      pendingAttachments.splice(i, 1);
      renderPendingAttachments();
    });
    host.appendChild(chip);
  });
}

function buildAttachmentPreamble() {
  if (!pendingAttachments.length) return "";
  const blocks = pendingAttachments.map(
    (p) =>
      `[Attached file: ${p.name}]\n${p.content}\n[End of ${p.name}]`,
  );
  return blocks.join("\n\n") + "\n\n";
}

/* Composer + now stages; wing-permanent upload uses its own button. */
els.attachFileInput.addEventListener("change", async (e) => {
  await stageMany(e.target.files);
  els.attachFileInput.value = "";
});

if (els.wingFileInput) {
  els.wingFileInput.addEventListener("change", async (e) => {
    await uploadFiles(e.target.files);
    els.wingFileInput.value = "";
  });
}

if (els.uploadWingFileBtn) {
  els.uploadWingFileBtn.addEventListener("click", () =>
    els.wingFileInput.click(),
  );
}

let _dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  _dragDepth++;
  els.dragOverlay.hidden = false;
  els.chatArea.classList.add("drag-over");
  els.dragWing.textContent = state.prefs.wing || "personal";
});
window.addEventListener("dragleave", () => {
  _dragDepth = Math.max(0, _dragDepth - 1);
  if (_dragDepth === 0) {
    els.dragOverlay.hidden = true;
    els.chatArea.classList.remove("drag-over");
  }
});
window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  if (!e.dataTransfer) return;
  e.preventDefault();
  _dragDepth = 0;
  els.dragOverlay.hidden = true;
  els.chatArea.classList.remove("drag-over");
  const files = await collectFromDataTransfer(e.dataTransfer);
  if (!files.length) return;
  // Dropping onto the settings panel → persist to wing; onto the chat area → stage for message.
  const onSettings = els.settingsOverlay && !els.settingsOverlay.hidden;
  if (onSettings) await uploadFiles(files);
  else await stageMany(files);
});

/* ─── Memory modal ────────────────────────────────────────────────────── */

const browserState = { offset: 0, limit: 50, total: 0 };

function fmtTime(iso) {
  if (!iso) return "?";
  try {
    const d = new Date(iso);
    return (
      d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return iso;
  }
}

async function loadStats() {
  els.statsContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/stats");
    const data = await r.json();
    const wingsArr = Object.entries(data.wings || {}).sort((a, b) => b[1] - a[1]);
    const roomsArr = Object.entries(data.rooms || {}).sort((a, b) => b[1] - a[1]);
    const maxW = Math.max(1, ...wingsArr.map((w) => w[1]));
    const maxR = Math.max(1, ...roomsArr.map((r) => r[1]));
    const wingsCount = Object.keys(data.wings || {}).length;
    const roomsCount = Object.keys(data.rooms || {}).length;
    els.statsContent.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="label">total drawers</div>
          <div class="value">${data.total ?? 0}</div>
        </div>
        <div class="stat-card">
          <div class="label">wings</div>
          <div class="value">${wingsCount}</div>
        </div>
        <div class="stat-card">
          <div class="label">rooms</div>
          <div class="value">${roomsCount}</div>
        </div>
      </div>
      <div class="stats-section">
        <h4>Wings (top 10)</h4>
        ${wingsArr
          .slice(0, 10)
          .map(
            ([name, count]) => `
          <div class="bar-row">
            <span class="bar-name">${escapeHtml(name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(count / maxW) * 100}%"></span></span>
            <span class="bar-count">${count}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="stats-section">
        <h4>Rooms (top 10)</h4>
        ${roomsArr
          .slice(0, 10)
          .map(
            ([name, count]) => `
          <div class="bar-row">
            <span class="bar-name">${escapeHtml(name)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(count / maxR) * 100}%"></span></span>
            <span class="bar-count">${count}</span>
          </div>
        `,
          )
          .join("")}
      </div>
      <div class="muted" style="margin-top:14px">palace path: <code>${escapeHtml(data.palace_path || "")}</code></div>
    `;
  } catch (e) {
    els.statsContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadTaxonomy() {
  els.taxonomyContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/taxonomy");
    const data = await r.json();
    const tax = data.taxonomy || {};
    const keys = Object.keys(tax).sort();
    if (!keys.length) {
      els.taxonomyContent.innerHTML =
        '<div class="muted">No drawers yet. Send a message or attach a file to get started.</div>';
      return;
    }
    els.taxonomyContent.innerHTML = keys
      .map((wing) => {
        const rooms = tax[wing] || {};
        const roomEntries = Object.entries(rooms).sort((a, b) => b[1] - a[1]);
        const total = roomEntries.reduce((s, [, c]) => s + c, 0);
        return `
        <div class="tax-wing">
          <div class="tax-wing-name">
            <span>${escapeHtml(wing)}</span>
            <span class="tax-wing-count">${total} drawers</span>
          </div>
          <div class="tax-rooms">
            ${roomEntries
              .map(
                ([r, c]) =>
                  `<div class="tax-room"><span>${escapeHtml(r)}</span><span>${c}</span></div>`,
              )
              .join("")}
          </div>
        </div>
      `;
      })
      .join("");
  } catch (e) {
    els.taxonomyContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadRecent() {
  els.recentContent.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/recent?limit=30");
    const data = await r.json();
    const rows = data.recent || [];
    if (!rows.length) {
      els.recentContent.innerHTML =
        '<div class="muted">No recent activity.</div>';
      return;
    }
    els.recentContent.innerHTML = rows
      .map(
        (row) => `
      <div class="recent-row">
        <div class="when">${fmtTime(row.filed_at)} · ${escapeHtml(row.added_by || "?")}</div>
        <div class="where">${escapeHtml(row.wing)} / ${escapeHtml(row.room)}</div>
        <div class="preview">${escapeHtml(row.preview || "")}</div>
      </div>
    `,
      )
      .join("");
  } catch (e) {
    els.recentContent.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function populateBrowserWingFilter() {
  els.browserWing.innerHTML =
    `<option value="">all wings</option>` +
    state.wings
      .map(
        (w) =>
          `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)} (${w.drawer_count})</option>`,
      )
      .join("");
}

async function loadBrowser() {
  const wing = els.browserWing.value || undefined;
  const room = els.browserRoom.value.trim() || undefined;
  const q = els.browserQ.value.trim() || undefined;
  const params = new URLSearchParams();
  if (wing) params.set("wing", wing);
  if (room) params.set("room", room);
  if (q) params.set("q", q);
  params.set("limit", String(browserState.limit));
  params.set("offset", String(browserState.offset));
  els.browserList.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch(`/api/drawers?${params.toString()}`);
    const data = await r.json();
    browserState.total = data.total || 0;
    const rows = data.drawers || [];
    if (!rows.length) {
      els.browserList.innerHTML =
        '<div class="muted">No drawers match these filters.</div>';
    } else {
      els.browserList.innerHTML = "";
      for (const row of rows) {
        const card = document.createElement("div");
        card.className = "drawer-row";
        card.innerHTML = `
          <div class="meta-line">
            <span>${escapeHtml(row.wing)} / ${escapeHtml(row.room)}</span>
            <span>${fmtTime(row.filed_at)} · ${row.length}c · ${escapeHtml(row.added_by || "?")}</span>
          </div>
          <div class="preview">${escapeHtml(row.preview || "")}</div>
          <div class="edit-area">
            <textarea></textarea>
            <div class="edit-row">
              <span class="muted">wing</span>
              <input class="edit-wing" value="${escapeHtml(row.wing)}" />
              <span class="muted">room</span>
              <input class="edit-room" value="${escapeHtml(row.room)}" />
              <button class="primary save-btn" type="button">save</button>
              <button class="danger del-btn" type="button">delete</button>
              <span class="muted edit-status"></span>
            </div>
          </div>
        `;
        let loadedFull = false;
        card.addEventListener("click", async (e) => {
          if (
            e.target.tagName === "TEXTAREA" ||
            e.target.tagName === "INPUT" ||
            e.target.tagName === "BUTTON"
          )
            return;
          const wasExpanded = card.classList.toggle("expanded");
          if (wasExpanded && !loadedFull) {
            const ta = card.querySelector("textarea");
            ta.value = "loading…";
            try {
              const dr = await fetch(
                `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              );
              const dd = await dr.json();
              ta.value = dd.content || dd.error || "";
              loadedFull = true;
            } catch (err) {
              ta.value = `error: ${err.message}`;
            }
          }
        });
        card.querySelector(".save-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          const ta = card.querySelector("textarea");
          const ewing = card.querySelector(".edit-wing").value.trim();
          const eroom = card.querySelector(".edit-room").value.trim();
          const status = card.querySelector(".edit-status");
          status.textContent = "saving…";
          try {
            const r = await fetch(
              `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: ta.value,
                  wing: ewing || undefined,
                  room: eroom || undefined,
                }),
              },
            );
            const d = await r.json();
            if (!r.ok || d.success === false)
              throw new Error(d.error || d.detail || "failed");
            status.textContent = "saved";
            setTimeout(() => (status.textContent = ""), 2000);
            loadWings(state.prefs.wing);
          } catch (err) {
            status.textContent = `error: ${err.message}`;
          }
        });
        card.querySelector(".del-btn").addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm("Delete this drawer? This cannot be undone."))
            return;
          try {
            const r = await fetch(
              `/api/drawers/${encodeURIComponent(row.drawer_id)}`,
              { method: "DELETE" },
            );
            const d = await r.json();
            if (!r.ok || d.success === false)
              throw new Error(d.error || d.detail || "failed");
            card.remove();
            loadWings(state.prefs.wing);
          } catch (err) {
            alert(`delete failed: ${err.message}`);
          }
        });
        els.browserList.appendChild(card);
      }
    }
    const start = browserState.offset + 1;
    const end = browserState.offset + rows.length;
    els.browserPage.textContent = `${start}-${end} of ${browserState.total}`;
    els.browserPrev.disabled = browserState.offset <= 0;
    els.browserNext.disabled =
      browserState.offset + browserState.limit >= browserState.total;
  } catch (e) {
    els.browserList.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".tab-pane").forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
  if (name === "stats") loadStats();
  else if (name === "taxonomy") loadTaxonomy();
  else if (name === "recent") loadRecent();
  else if (name === "browser") {
    populateBrowserWingFilter();
    loadBrowser();
  } else if (name === "graph") loadKgStats();
  else if (name === "tunnels") loadTunnels();
  else if (name === "diary") loadDiary();
}

/* ─── Knowledge Graph ──────────────────────────────────────────────────── */

async function loadKgStats() {
  const el = document.getElementById("kg-stats");
  if (!el) return;
  el.textContent = "loading…";
  try {
    const r = await fetch("/api/kg/stats");
    const d = await r.json();
    if (d.error) {
      el.textContent = `KG: ${d.error}`;
      return;
    }
    const parts = [];
    if ("triples" in d) parts.push(`${d.triples} facts`);
    if ("entities" in d) parts.push(`${d.entities} entities`);
    if ("predicates" in d) parts.push(`${d.predicates} predicates`);
    el.textContent = parts.length ? parts.join(" · ") : JSON.stringify(d);
  } catch (e) {
    el.textContent = `error: ${e.message}`;
  }
}

function renderKgFacts(facts, container) {
  if (!facts || !facts.length) {
    container.innerHTML = '<div class="muted">no facts</div>';
    return;
  }
  container.innerHTML = "";
  for (const f of facts) {
    const subj = f.subject || f.subj || "?";
    const pred = f.predicate || f.pred || "?";
    const obj = f.object || f.obj || "?";
    const vf = f.valid_from || "";
    const vu = f.valid_until || f.ended || "";
    const row = document.createElement("div");
    row.className = "kg-fact";
    row.innerHTML = `
      <div>
        <div class="triple">${escapeHtml(subj)} → <b>${escapeHtml(pred)}</b> → ${escapeHtml(obj)}</div>
        <div class="when">${vf ? `from ${escapeHtml(vf)}` : ""}${vu ? ` · ended ${escapeHtml(vu)}` : ""}</div>
      </div>
      <div class="actions">
        <button class="danger invalidate-btn" type="button">invalidate</button>
      </div>
    `;
    row.querySelector(".invalidate-btn").addEventListener("click", async () => {
      if (!confirm(`Mark this fact as no longer true?`)) return;
      try {
        const r = await fetch("/api/kg/invalidate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subject: subj, predicate: pred, object: obj }),
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "failed");
        setStatus(`invalidated`, "warn");
        document.getElementById("kg-search").click();
      } catch (e) {
        setStatus(`invalidate failed: ${e.message}`, "err");
      }
    });
    container.appendChild(row);
  }
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "kg-search") {
    const entity = document.getElementById("kg-entity").value.trim();
    const asof = document.getElementById("kg-asof").value.trim();
    const out = document.getElementById("kg-results");
    if (!entity) {
      out.innerHTML = '<div class="muted">enter an entity name first</div>';
      return;
    }
    out.innerHTML = '<div class="muted">querying…</div>';
    try {
      const params = new URLSearchParams({ entity });
      if (asof) params.set("as_of", asof);
      const r = await fetch(`/api/kg/query?${params.toString()}`);
      const d = await r.json();
      if (d.error) {
        out.innerHTML = `<div class="muted">${escapeHtml(d.error)}</div>`;
        return;
      }
      renderKgFacts(d.facts || [], out);
    } catch (err) {
      out.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
    }
  } else if (e.target.id === "kg-timeline-btn") {
    const entity = document.getElementById("kg-entity").value.trim();
    const out = document.getElementById("kg-results");
    out.innerHTML = '<div class="muted">loading timeline…</div>';
    try {
      const params = new URLSearchParams();
      if (entity) params.set("entity", entity);
      const r = await fetch(`/api/kg/timeline?${params.toString()}`);
      const d = await r.json();
      renderKgFacts(d.timeline || [], out);
    } catch (err) {
      out.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
    }
  } else if (e.target.id === "kg-add-btn") {
    const subj = document.getElementById("kg-subj").value.trim();
    const pred = document.getElementById("kg-pred").value.trim();
    const obj = document.getElementById("kg-obj").value.trim();
    const vf = document.getElementById("kg-from").value.trim();
    const status = document.getElementById("kg-add-status");
    if (!subj || !pred || !obj) {
      status.textContent = "subject, predicate, and object are required";
      return;
    }
    status.textContent = "adding…";
    try {
      const r = await fetch("/api/kg/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subj,
          predicate: pred,
          object: obj,
          valid_from: vf || null,
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "failed");
      status.textContent = `added: ${d.fact}`;
      ["kg-subj", "kg-pred", "kg-obj", "kg-from"].forEach(
        (i) => (document.getElementById(i).value = ""),
      );
      loadKgStats();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  } else if (e.target.id === "tunnel-add-btn") {
    setStatus("tunnel create not yet wired (Pack D)", "warn");
  } else if (e.target.id === "diary-write-btn") {
    const entry = document.getElementById("diary-entry").value.trim();
    const topic =
      document.getElementById("diary-topic").value.trim() || "general";
    const status = document.getElementById("diary-write-status");
    if (!entry) {
      status.textContent = "write something first";
      return;
    }
    status.textContent = "saving…";
    try {
      const r = await fetch("/api/diary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entry, topic }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "failed");
      status.textContent = `saved`;
      document.getElementById("diary-entry").value = "";
      loadDiary();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  }
});

/* ─── Diary ────────────────────────────────────────────────────────────── */

async function loadDiary() {
  const el = document.getElementById("diary-list");
  if (!el) return;
  el.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/diary?last_n=20");
    const d = await r.json();
    const entries = d.entries || d.diary || [];
    if (!entries.length) {
      el.innerHTML = '<div class="muted">No diary entries yet.</div>';
      return;
    }
    el.innerHTML = "";
    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "diary-row";
      const when = e.timestamp || e.filed_at || "";
      const text = e.entry || e.content || "";
      const topic = e.topic ? ` · ${e.topic}` : "";
      row.innerHTML = `
        <div class="when">${fmtTime(when)}${escapeHtml(topic)}</div>
        <div class="entry">${escapeHtml(text)}</div>
      `;
      el.appendChild(row);
    }
  } catch (err) {
    el.innerHTML = `<div class="muted">error: ${escapeHtml(err.message)}</div>`;
  }
}

/* ─── Tunnels ──────────────────────────────────────────────────────────── */

async function loadTunnels() {
  const el = document.getElementById("tunnels-list");
  if (!el) return;
  el.innerHTML = '<div class="muted">loading…</div>';
  try {
    const r = await fetch("/api/tunnels");
    const d = await r.json();
    const tunnels = Array.isArray(d) ? d : d.tunnels || d.results || [];
    if (!tunnels.length) {
      el.innerHTML =
        '<div class="muted">No tunnels yet. Create one above to link two rooms across wings.</div>';
      return;
    }
    el.innerHTML = "";
    for (const t of tunnels) {
      const row = document.createElement("div");
      row.className = "tunnel-row";
      const sw = t.source?.wing || t.source_wing || "?";
      const sr = t.source?.room || t.source_room || "?";
      const tw = t.target?.wing || t.target_wing || "?";
      const tr = t.target?.room || t.target_room || "?";
      const lbl = t.label || t.kind || "";
      const id = t.id || t.tunnel_id || "";
      row.innerHTML = `
        <div>
          <div>${escapeHtml(sw)}/${escapeHtml(sr)} ⇆ ${escapeHtml(tw)}/${escapeHtml(tr)}</div>
          <div class="muted" style="font-size:10px">${escapeHtml(lbl)} · ${escapeHtml(id)}</div>
        </div>
        <button class="danger del-tunnel" type="button">delete</button>
      `;
      row.querySelector(".del-tunnel").addEventListener("click", async () => {
        if (!confirm("Delete this tunnel?")) return;
        try {
          const dr = await fetch(`/api/tunnels/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          const dd = await dr.json();
          if (dd.error) throw new Error(dd.error);
          loadTunnels();
        } catch (e) {
          alert(`delete failed: ${e.message}`);
        }
      });
      el.appendChild(row);
    }
  } catch (e) {
    el.innerHTML = `<div class="muted">error: ${escapeHtml(e.message)}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  if (e.target.id === "tunnel-add-btn") {
    const sw = document.getElementById("tunnel-wing-a").value.trim();
    const sr = document.getElementById("tunnel-room-a").value.trim();
    const tw = document.getElementById("tunnel-wing-b").value.trim();
    const tr = document.getElementById("tunnel-room-b").value.trim();
    const lbl = document.getElementById("tunnel-kind").value.trim();
    const status = document.getElementById("tunnel-status");
    if (!sw || !sr || !tw || !tr) {
      status.textContent = "all four wing/room fields are required";
      return;
    }
    status.textContent = "creating…";
    try {
      const r = await fetch("/api/tunnels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_wing: sw,
          source_room: sr,
          target_wing: tw,
          target_room: tr,
          label: lbl || "related",
        }),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      status.textContent = "created";
      ["tunnel-wing-a", "tunnel-room-a", "tunnel-wing-b", "tunnel-room-b"].forEach(
        (i) => (document.getElementById(i).value = ""),
      );
      loadTunnels();
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    }
  } else if (e.target.id === "reconnect-btn") {
    e.target.disabled = true;
    e.target.textContent = "reconnecting…";
    try {
      const r = await fetch("/api/reconnect", { method: "POST" });
      const d = await r.json();
      setStatus(
        d.success ? `reconnected (${d.drawers} drawers)` : `failed: ${d.error || d.message}`,
        d.success ? "ok" : "err",
      );
      loadStats();
    } catch (err) {
      setStatus(`reconnect failed: ${err.message}`, "err");
    } finally {
      e.target.disabled = false;
      e.target.textContent = "reconnect to palace";
    }
  } else if (e.target.id === "import-convos-btn") {
    const wing = state.prefs.wing || "personal";
    const path = document.getElementById("import-convos-path").value.trim();
    const status = document.getElementById("import-convos-status");
    if (!path) {
      status.textContent = "enter a folder path first";
      return;
    }
    status.textContent = "importing… (this can take minutes)";
    e.target.disabled = true;
    try {
      const r = await fetch(
        `/api/wings/${encodeURIComponent(wing)}/import-convos`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.detail || JSON.stringify(d));
      status.textContent = `imported into ${wing}`;
      loadAttachments();
      loadWings(wing);
    } catch (err) {
      status.textContent = `error: ${err.message}`;
    } finally {
      e.target.disabled = false;
    }
  }
});

/* ─── AAAK viewer ──────────────────────────────────────────────────────── */

async function loadAaak() {
  const el = document.getElementById("aaak-spec-text");
  if (!el) return;
  el.textContent = "loading…";
  try {
    const r = await fetch("/api/aaak-spec");
    const d = await r.json();
    el.textContent = d.aaak_spec || JSON.stringify(d, null, 2);
  } catch (e) {
    el.textContent = `error: ${e.message}`;
  }
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => switchTab(t.dataset.tab));
});

els.openMemory.addEventListener("click", () => {
  els.memoryOverlay.hidden = false;
  switchTab("stats");
});
els.closeMemoryModal.addEventListener("click", () => {
  els.memoryOverlay.hidden = true;
});
els.memoryOverlay.addEventListener("click", (e) => {
  if (e.target === els.memoryOverlay) els.memoryOverlay.hidden = true;
});

els.browserReload.addEventListener("click", () => {
  browserState.offset = 0;
  loadBrowser();
});
els.browserPrev.addEventListener("click", () => {
  browserState.offset = Math.max(0, browserState.offset - browserState.limit);
  loadBrowser();
});
els.browserNext.addEventListener("click", () => {
  browserState.offset += browserState.limit;
  loadBrowser();
});
[els.browserWing, els.browserRoom, els.browserQ].forEach((el) => {
  el.addEventListener("change", () => {
    browserState.offset = 0;
    loadBrowser();
  });
});

els.saveIdentity.addEventListener("click", saveIdentity);
els.resetIdentity.addEventListener("click", resetIdentity);
els.refreshWakeup.addEventListener("click", loadWakeup);

els.wing.addEventListener("change", () => setCurrentWing(els.wing.value));
els.topbarWing.addEventListener("change", () => setCurrentWing(els.topbarWing.value));
els.room.addEventListener("change", () => setCurrentRoom(els.room.value || "general"));

async function newWingFlow() {
  const name = prompt("New wing name");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  rememberWing(trimmed);
  await loadWings(trimmed);
  setCurrentWing(trimmed);
}

els.wingNew.addEventListener("click", newWingFlow);
els.topbarWingNew.addEventListener("click", newWingFlow);

els.wingRename.addEventListener("click", renameWing);
els.wingDelete.addEventListener("click", deleteWing);

const prefInputs = [
  els.model,
  els.tRecall,
  els.tSave,
  els.tExtract,
  els.tIdentity,
];
if (els.tTools) prefInputs.push(els.tTools);
prefInputs.forEach((el) => el.addEventListener("change", savePrefs));

els.wingPrompt.addEventListener("blur", saveWingPromptForCurrent);
if (els.wingPromptPicker) {
  els.wingPromptPicker.addEventListener("change", () => {
    const w = promptTargetWing();
    els.wingPrompt.value = state.wingPrompts[w] || "";
  });
}

/* ─── Init ─────────────────────────────────────────────────────────────── */

(async function init() {
  setStatus("loading…", "");
  // One-time migration: prefs from earlier sessions may have stored
  // recall/save/etc. as false. The empty-state text promises these are
  // on by default, so reset them once when the defaults version changes.
  if ((state.prefs.defaultsVersion || 0) < PREFS_DEFAULTS_VERSION) {
    state.prefs.recall = true;
    state.prefs.save = true;
    state.prefs.extract = true;
    state.prefs.identity = true;
    state.prefs.defaultsVersion = PREFS_DEFAULTS_VERSION;
  }
  els.tRecall.checked = state.prefs.recall !== false;
  els.tSave.checked = state.prefs.save !== false;
  els.tExtract.checked = state.prefs.extract !== false;
  els.tIdentity.checked = state.prefs.identity !== false;
  if (els.tTools) els.tTools.checked = !!state.prefs.tools;
  state.prefs.recall = els.tRecall.checked;
  state.prefs.save = els.tSave.checked;
  state.prefs.extract = els.tExtract.checked;
  state.prefs.identity = els.tIdentity.checked;
  saveJSON(PREFS_KEY, state.prefs);
  els.room.value = state.prefs.room || "general";
  syncRecallButton();

  await loadModels();
  await loadWings(state.prefs.wing);

  ensureSession();
  syncWingFilter();
  renderMessages();
  renderHits([]);

  try {
    const h = await fetch("/api/health").then((r) => r.json());
    els.palaceLabel.textContent = h.palace_path;
  } catch {}

  // First-run: open settings once so the user can set identity. Mark seen
  // either way so it never auto-opens again, even if they close it without
  // saving.
  if (!localStorage.getItem(ONBOARDED_KEY)) {
    localStorage.setItem(ONBOARDED_KEY, String(Date.now()));
    openSettings();
  }

  setStatus("ready", "ok");
  els.input.focus();
})();

const $ = (id) => document.getElementById(id);

const SESSIONS_KEY = "ollama-mempalace.sessions.v1";
const ACTIVE_KEY = "ollama-mempalace.activeSession";
const PREFS_KEY = "ollama-mempalace.prefs.v1";
const WING_PROMPT_KEY = "ollama-mempalace.wing_prompts.v1";
const KNOWN_WINGS_KEY = "ollama-mempalace.knownWings.v1";
const ONBOARDED_KEY = "ollama-mempalace.onboarded";

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
    showMemory: false,
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
  openSettings: $("open-settings"),
  sessions: $("sessions"),
  topbarWing: $("topbar-wing"),
  topbarRoom: $("topbar-room"),
  topbarWingNew: $("topbar-wing-new"),
  palaceLabel: $("palace-label"),
  emptyState: $("empty-state"),
  messages: $("messages"),
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
  refreshWakeup: $("refresh-wakeup"),
  wakeupTokens: $("wakeup-tokens"),
  wakeupText: $("wakeup-text"),
};

function savePrefs() {
  state.prefs.model = els.model.value;
  state.prefs.wing = els.wing.value || state.prefs.wing;
  state.prefs.room = els.room.value || state.prefs.room;
  state.prefs.recall = els.tRecall.checked;
  state.prefs.save = els.tSave.checked;
  state.prefs.extract = els.tExtract.checked;
  state.prefs.identity = els.tIdentity.checked;
  saveJSON(PREFS_KEY, state.prefs);
  syncRecallButton();
}

function syncRecallButton() {
  els.composerRecall.classList.toggle("on", state.prefs.recall);
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

function createSession() {
  const s = {
    id: uuid(),
    title: "New chat",
    wing: state.prefs.wing || "personal",
    room: state.prefs.room || "general",
    model: state.prefs.model || (state.models[0] ?? ""),
    createdAt: now(),
    updatedAt: now(),
    messages: [],
  };
  state.sessions.unshift(s);
  state.activeId = s.id;
  localStorage.setItem(ACTIVE_KEY, s.id);
  saveJSON(SESSIONS_KEY, state.sessions);
  return s;
}

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
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = today - 6 * 86400000;
  const buckets = { Today: [], "This Week": [], Older: [] };
  for (const s of state.sessions) {
    if (s.updatedAt >= today) buckets.Today.push(s);
    else if (s.updatedAt >= week) buckets["This Week"].push(s);
    else buckets.Older.push(s);
  }
  return buckets;
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
      item.className = `session-item${s.id === state.activeId ? " active" : ""}`;
      item.innerHTML = `
        <span class="title">${escapeHtml(s.title || "Untitled")}</span>
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
      item.querySelector(".delete").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete chat "${s.title}"? Memory drawers stay in MemPalace.`))
          return;
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
    div.innerHTML = `<span class="role">${m.role}</span>${escapeHtml(m.content)}`;
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
}

function setCurrentRoom(name) {
  els.room.value = name;
  els.topbarRoom.value = name;
  state.prefs.room = name;
  const s = getActiveSession();
  if (s) s.room = name;
  saveJSON(PREFS_KEY, state.prefs);
  saveJSON(SESSIONS_KEY, state.sessions);
}

function loadWingPromptForCurrent() {
  const w = els.wing.value;
  els.wingPrompt.value = state.wingPrompts[w] || "";
}

function saveWingPromptForCurrent() {
  const w = els.wing.value;
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

  const userMsg = { role: "user", content: text };
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
    use_memory: state.prefs.recall,
    save_to_memory: state.prefs.save,
    auto_extract: state.prefs.extract,
    use_identity: state.prefs.identity,
    system_prompt: state.wingPrompts[session.wing] || null,
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
els.composerPlus.addEventListener("click", openSettings);
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
}

els.saveIdentity.addEventListener("click", saveIdentity);
els.resetIdentity.addEventListener("click", resetIdentity);
els.refreshWakeup.addEventListener("click", loadWakeup);

els.wing.addEventListener("change", () => setCurrentWing(els.wing.value));
els.topbarWing.addEventListener("change", () => setCurrentWing(els.topbarWing.value));
els.room.addEventListener("change", () => setCurrentRoom(els.room.value || "general"));
els.topbarRoom.addEventListener("change", () =>
  setCurrentRoom(els.topbarRoom.value || "general"),
);

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

[els.model, els.tRecall, els.tSave, els.tExtract, els.tIdentity].forEach((el) =>
  el.addEventListener("change", savePrefs),
);

els.wingPrompt.addEventListener("blur", saveWingPromptForCurrent);

/* ─── Init ─────────────────────────────────────────────────────────────── */

(async function init() {
  setStatus("loading…", "");
  els.tRecall.checked = state.prefs.recall;
  els.tSave.checked = state.prefs.save;
  els.tExtract.checked = state.prefs.extract;
  els.tIdentity.checked = state.prefs.identity;
  els.room.value = state.prefs.room || "general";
  syncRecallButton();

  await loadModels();
  await loadWings(state.prefs.wing);
  els.topbarRoom.value = state.prefs.room || "general";

  ensureSession();
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

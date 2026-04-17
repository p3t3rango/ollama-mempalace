const $ = (id) => document.getElementById(id);

const state = {
  messages: [],
  wings: [],
  models: [],
};

const els = {
  model: $("model"),
  wing: $("wing"),
  room: $("room"),
  useMemory: $("use-memory"),
  saveMemory: $("save-memory"),
  messages: $("messages"),
  input: $("input"),
  composer: $("composer"),
  send: $("send"),
  hits: $("hits"),
  status: $("status"),
  newChat: $("new-chat"),
  newWing: $("wing-new"),
  renameWing: $("wing-rename"),
  deleteWing: $("wing-delete"),
};

const STORE_KEY = "ollama-mempalace.prefs";

function savePrefs() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      model: els.model.value,
      wing: els.wing.value,
      room: els.room.value,
      useMemory: els.useMemory.checked,
      saveMemory: els.saveMemory.checked,
    }),
  );
}

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = kind;
}

function escapeHtml(s) {
  return (s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMessages() {
  els.messages.innerHTML = "";
  for (const m of state.messages) {
    const div = document.createElement("div");
    div.className = `msg ${m.role}`;
    div.innerHTML = `<span class="role">${m.role}</span>${escapeHtml(m.content)}`;
    els.messages.appendChild(div);
  }
  els.messages.scrollTop = els.messages.scrollHeight;
}

function appendNote(text) {
  const div = document.createElement("div");
  div.className = "msg system-note";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderHits(hits) {
  els.hits.innerHTML = "";
  if (!hits || !hits.length) {
    els.hits.innerHTML = '<div class="hit-empty">no memories pulled in for this turn</div>';
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

async function loadModels() {
  try {
    const r = await fetch("/api/models");
    const data = await r.json();
    state.models = data.models || [];
    els.model.innerHTML = state.models
      .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
      .join("");
    const prefs = loadPrefs();
    if (prefs.model && state.models.includes(prefs.model)) {
      els.model.value = prefs.model;
    }
  } catch (e) {
    setStatus(`models: ${e.message}`, "err");
  }
}

async function loadWings(preferred) {
  try {
    const r = await fetch("/api/wings");
    const data = await r.json();
    state.wings = data.wings || [];
    const prefs = loadPrefs();
    const desired = preferred || prefs.wing || "personal";
    let opts = state.wings.map(
      (w) =>
        `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)} (${w.drawer_count})</option>`,
    );
    if (!state.wings.some((w) => w.name === desired)) {
      opts.unshift(`<option value="${escapeHtml(desired)}">${escapeHtml(desired)} (new)</option>`);
    }
    els.wing.innerHTML = opts.join("");
    els.wing.value = desired;
  } catch (e) {
    setStatus(`wings: ${e.message}`, "err");
  }
}

async function sendMessage(text) {
  state.messages.push({ role: "user", content: text });
  state.messages.push({ role: "assistant", content: "" });
  renderMessages();
  els.send.disabled = true;
  setStatus("…thinking", "");

  const body = {
    model: els.model.value,
    wing: els.wing.value,
    room: els.room.value || "general",
    messages: state.messages.slice(0, -1),
    use_memory: els.useMemory.checked,
    save_to_memory: els.saveMemory.checked,
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
        const lines = block.split("\n");
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
          let evt;
          try {
            evt = JSON.parse(payload);
          } catch {
            continue;
          }
          if (evt.type === "memory_hits") {
            renderHits(evt.hits);
            setStatus(`pulled ${evt.hits.length} memories from ${evt.wing}/${evt.room}`, "");
          } else if (evt.type === "token") {
            assistantText += evt.content;
            state.messages[state.messages.length - 1].content = assistantText;
            renderMessages();
          } else if (evt.type === "done") {
            if (evt.saved_drawer_id) {
              setStatus(`saved → ${evt.saved_drawer_id}`, "ok");
            } else if (evt.save_error) {
              setStatus(`save error: ${evt.save_error}`, "warn");
            } else {
              setStatus("done (not saved)", "");
            }
          } else if (evt.type === "error") {
            setStatus(`stream error: ${evt.message}`, "err");
          } else if (evt.type === "save_error") {
            setStatus(`save error: ${evt.message}`, "warn");
          }
        }
      }
    }
  } catch (e) {
    setStatus(e.message, "err");
    state.messages[state.messages.length - 1].content =
      assistantText || `[error: ${e.message}]`;
    renderMessages();
  } finally {
    els.send.disabled = false;
    loadWings(els.wing.value);
  }
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  savePrefs();
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    els.composer.dispatchEvent(new Event("submit"));
  }
});

els.newChat.addEventListener("click", () => {
  state.messages = [];
  renderMessages();
  renderHits([]);
  setStatus("new chat — same wing", "");
});

els.newWing.addEventListener("click", async () => {
  const name = prompt("new wing name (will be created on first save)");
  if (!name) return;
  await loadWings(name.trim());
  savePrefs();
});

els.renameWing.addEventListener("click", async () => {
  const old = els.wing.value;
  const next = prompt(`rename wing "${old}" to:`, old);
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
    await loadWings(next.trim());
    savePrefs();
  } catch (e) {
    setStatus(`rename failed: ${e.message}`, "err");
  }
});

els.deleteWing.addEventListener("click", async () => {
  const name = els.wing.value;
  if (!confirm(`Delete wing "${name}" and ALL its drawers? This cannot be undone.`)) return;
  try {
    const r = await fetch(`/api/wings/${encodeURIComponent(name)}`, { method: "DELETE" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || JSON.stringify(data));
    setStatus(`deleted ${data.deleted} drawers from ${name}`, "warn");
    await loadWings("personal");
  } catch (e) {
    setStatus(`delete failed: ${e.message}`, "err");
  }
});

[els.model, els.wing, els.room, els.useMemory, els.saveMemory].forEach((el) => {
  el.addEventListener("change", savePrefs);
});

(async function init() {
  setStatus("loading…", "");
  await loadModels();
  await loadWings();
  const prefs = loadPrefs();
  if (prefs.room) els.room.value = prefs.room;
  if (typeof prefs.useMemory === "boolean") els.useMemory.checked = prefs.useMemory;
  if (typeof prefs.saveMemory === "boolean") els.saveMemory.checked = prefs.saveMemory;
  setStatus(`ready — palace: ~/.mempalace/palace`, "ok");
  renderHits([]);
})();

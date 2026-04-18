"""ollama-mempalace — local chat UI that wires Ollama models to MemPalace memory."""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from mempalace.config import MempalaceConfig, sanitize_name
from mempalace.general_extractor import extract_memories
from mempalace.layers import MemoryStack
from mempalace.mcp_server import (
    tool_add_drawer,
    tool_check_duplicate,
    tool_create_tunnel,
    tool_delete_drawer,
    tool_delete_tunnel,
    tool_diary_read,
    tool_diary_write,
    tool_follow_tunnels,
    tool_get_aaak_spec,
    tool_get_drawer,
    tool_kg_add,
    tool_kg_invalidate,
    tool_kg_query,
    tool_kg_stats,
    tool_kg_timeline,
    tool_list_drawers,
    tool_list_tunnels,
    tool_reconnect,
    tool_update_drawer,
)
from mempalace.palace import get_collection
from mempalace.searcher import search_memories

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_ROOM = "general"
DEFAULT_WING = "personal"
FACTS_ROOM = "hall_facts"
ATTACH_ROOM = "attachments"
MAX_ATTACH_BYTES = 5 * 1024 * 1024  # 5 MB
CHUNK_TARGET_CHARS = 1500

# Map general_extractor's memory_type → MemPalace hall room name.
# Anything missing falls back to "hall_facts".
HALL_FOR_MEMORY_TYPE = {
    "fact": "hall_facts",
    "preference": "hall_preferences",
    "decision": "hall_decisions",
    "discovery": "hall_discoveries",
    "event": "hall_events",
    "advice": "hall_advice",
    "warning": "hall_warnings",
    "instruction": "hall_instructions",
    "emotion": "hall_emotions",
    "identity": "hall_identity",
}

config = MempalaceConfig()
config.init()
PALACE_PATH = config.palace_path
Path(PALACE_PATH).mkdir(parents=True, exist_ok=True)

IDENTITY_PATH = Path(os.path.expanduser("~/.mempalace/identity.txt"))
PERSONAS_PATH = Path(os.path.expanduser("~/.mempalace/personas.json"))

app = FastAPI(title="ollama-mempalace")
STATIC_DIR = Path(__file__).parent / "static"


class Message(BaseModel):
    role: str
    content: str
    # Optional list of base64-encoded images (no data: prefix). Forwarded to
    # vision-capable Ollama models via the `images` field on the message dict.
    images: Optional[list[str]] = None


class ChatRequest(BaseModel):
    model: str
    wing: str = DEFAULT_WING
    room: str = DEFAULT_ROOM
    messages: list[Message]
    use_memory: bool = True
    save_to_memory: bool = True
    auto_extract: bool = True
    use_identity: bool = True
    enable_tools: bool = False
    system_prompt: Optional[str] = None
    session_id: Optional[str] = None
    memory_limit: int = Field(default=5, ge=1, le=20)
    persona: Optional[str] = None
    # Context window handling. When True, the server auto-summarizes older
    # message pairs before sending if the prompt would exceed
    # context_budget_pct of the model's reported context window.
    auto_compact: bool = True
    context_budget_pct: float = Field(default=0.75, ge=0.3, le=0.95)
    keep_recent_turns: int = Field(default=6, ge=2, le=20)
    # When True, after each save runs a small LLM pass to extract S/P/O
    # triples from the exchange and writes them to the knowledge graph.
    # Costs an extra Ollama call per turn; off by default.
    auto_kg: bool = False
    auto_kg_model: Optional[str] = None  # falls back to req.model if unset


class WingRenameBody(BaseModel):
    new_name: str


class IdentityBody(BaseModel):
    text: str


class PersonaBody(BaseModel):
    name: str
    description: str = ""
    identity: str


class SpeakBody(BaseModel):
    text: str
    voice: Optional[str] = None
    rate: Optional[int] = None  # words per minute


class DrawerUpdate(BaseModel):
    content: Optional[str] = None
    wing: Optional[str] = None
    room: Optional[str] = None


class DupeCheckBody(BaseModel):
    content: str
    threshold: float = 0.9


class KgAddBody(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_from: Optional[str] = None
    source_closet: Optional[str] = None


class KgInvalidateBody(BaseModel):
    subject: str
    predicate: str
    object: str
    ended: Optional[str] = None


class DiaryWriteBody(BaseModel):
    agent_name: str = "ollama-mempalace"
    entry: str
    topic: str = "general"


class TunnelCreateBody(BaseModel):
    source_wing: str
    source_room: str
    target_wing: str
    target_room: str
    label: str = ""


class ConvoImportBody(BaseModel):
    path: str
    limit: Optional[int] = None


def _safe_collection():
    try:
        return get_collection(PALACE_PATH, create=False)
    except Exception:
        return None


@app.get("/")
async def root():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
async def health():
    return {"ok": True, "palace_path": PALACE_PATH, "ollama_host": OLLAMA_HOST}


@app.get("/api/models")
async def list_models():
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            data = r.json()
        names = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return {"models": names}
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable at {OLLAMA_HOST}: {e}")


_MODEL_INFO_CACHE: dict[str, dict] = {}


@app.get("/api/model-info")
async def model_info(model: str):
    """Return basic model info from Ollama's /api/show. Cached per model."""
    if model in _MODEL_INFO_CACHE:
        return _MODEL_INFO_CACHE[model]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/show", json={"model": model}
            )
            r.raise_for_status()
            data = r.json()
    except Exception as e:
        raise HTTPException(502, f"Ollama show failed: {e}")
    info = data.get("model_info", {}) or {}
    # Find context length — varies by architecture (e.g. qwen2.context_length)
    context_length = 4096  # safe default
    for k, v in info.items():
        if isinstance(v, int) and k.endswith(".context_length"):
            context_length = v
            break
    out = {
        "model": model,
        "context_length": context_length,
        "parameters": data.get("details", {}).get("parameter_size"),
        "quantization": data.get("details", {}).get("quantization_level"),
        "capabilities": data.get("capabilities", []),
    }
    _MODEL_INFO_CACHE[model] = out
    return out


@app.get("/api/models/installed")
async def installed_models():
    """Detailed list of installed Ollama models — name, size, digest, modified."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            r.raise_for_status()
            data = r.json()
        return {"models": data.get("models", [])}
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable: {e}")


class ModelNameBody(BaseModel):
    name: str


@app.delete("/api/models/{name:path}")
async def delete_model(name: str):
    """Delete an installed Ollama model."""
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(
                "DELETE",
                f"{OLLAMA_HOST}/api/delete",
                json={"name": name},
            )
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"Ollama delete: {r.text[:300]}")
        # Bust caches
        _MODEL_INFO_CACHE.pop(name, None)
        return {"ok": True, "deleted": name}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, f"Ollama unreachable: {e}")


@app.post("/api/models/pull")
async def pull_model(body: ModelNameBody):
    """Pull a model. Streams Ollama's progress events as SSE."""
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "model name required")

    async def gen():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_HOST}/api/pull",
                    json={"name": name, "stream": True},
                ) as r:
                    if r.status_code != 200:
                        body_text = (await r.aread()).decode("utf-8", "replace")
                        yield (
                            "data: "
                            + json.dumps(
                                {"type": "error", "message": f"Ollama {r.status_code}: {body_text[:300]}"}
                            )
                            + "\n\n"
                        )
                        return
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        yield "data: " + json.dumps(chunk) + "\n\n"
                        if chunk.get("status") == "success":
                            return
        except Exception as e:
            yield (
                "data: "
                + json.dumps({"type": "error", "message": str(e)})
                + "\n\n"
            )

    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/wings")
async def list_wings():
    col = _safe_collection()
    if col is None:
        return {"wings": []}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"wings": [], "error": str(e)}
    counts: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        counts[w] = counts.get(w, 0) + 1
    wings = [{"name": w, "drawer_count": c} for w, c in sorted(counts.items())]
    return {"wings": wings}


@app.patch("/api/wings/{old_name}")
async def rename_wing(old_name: str, body: WingRenameBody):
    try:
        new_name = sanitize_name(body.new_name, "new_name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if new_name == old_name:
        return {"renamed": 0, "from": old_name, "to": new_name}
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    hits = col.get(where={"wing": old_name}, include=["metadatas", "documents"])
    ids = hits.get("ids") or []
    if not ids:
        raise HTTPException(404, f"Wing {old_name!r} has no drawers")
    new_metas = []
    for m in hits.get("metadatas") or []:
        nm = dict(m or {})
        nm["wing"] = new_name
        new_metas.append(nm)
    docs = hits.get("documents") or []
    col.upsert(ids=ids, documents=docs, metadatas=new_metas)
    return {"renamed": len(ids), "from": old_name, "to": new_name}


@app.delete("/api/wings/{name}")
async def delete_wing(name: str):
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    hits = col.get(where={"wing": name}, include=["metadatas"])
    ids = hits.get("ids") or []
    if not ids:
        raise HTTPException(404, f"Wing {name!r} has no drawers")
    col.delete(ids=ids)
    return {"deleted": len(ids), "wing": name}


def _safe_filename(name: str) -> str:
    return re.sub(r"[^\w.-]", "_", name)[:120] or "attachment"


def _chunk_text(text: str, target: int = CHUNK_TARGET_CHARS) -> list[str]:
    """Greedy paragraph-aware chunker. Falls back to hard splits for huge paragraphs."""
    paras = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for p in paras:
        p = p.strip()
        if not p:
            continue
        if len(p) > target * 2:
            if current:
                chunks.append("\n\n".join(current))
                current, current_len = [], 0
            for i in range(0, len(p), target):
                chunks.append(p[i : i + target])
            continue
        if current_len + len(p) > target and current:
            chunks.append("\n\n".join(current))
            current, current_len = [p], len(p)
        else:
            current.append(p)
            current_len += len(p) + 2
    if current:
        chunks.append("\n\n".join(current))
    return chunks


@app.post("/api/wings/{wing}/attach")
async def attach_to_wing(wing: str, file: UploadFile = File(...)):
    try:
        wing = sanitize_name(wing, "wing")
    except ValueError as e:
        raise HTTPException(400, str(e))

    raw = await file.read()
    if len(raw) > MAX_ATTACH_BYTES:
        raise HTTPException(
            413,
            f"File is {len(raw)} bytes; max is {MAX_ATTACH_BYTES} bytes ({MAX_ATTACH_BYTES // 1024 // 1024} MB).",
        )
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            400,
            "File is not UTF-8 text. Only text files (txt, md, json, code, etc.) are supported in v1.",
        )
    text = text.strip()
    if not text:
        raise HTTPException(400, "File is empty.")

    chunks = _chunk_text(text)
    safe_name = _safe_filename(file.filename or "attachment")

    saved: list[str] = []
    errors: list[str] = []
    for i, chunk in enumerate(chunks):
        result = tool_add_drawer(
            wing=wing,
            room=ATTACH_ROOM,
            content=chunk,
            source_file=f"attachment://{safe_name}#{i}",
            added_by="ollama-mempalace-attach",
        )
        if result.get("success"):
            did = result.get("drawer_id")
            if did:
                saved.append(did)
        else:
            errors.append(result.get("error", "unknown"))

    return {
        "filename": file.filename,
        "stored_as": safe_name,
        "chunks": len(chunks),
        "saved": len(saved),
        "errors": errors,
    }


@app.get("/api/wings/{wing}/attachments")
async def list_attachments(wing: str):
    col = _safe_collection()
    if col is None:
        return {"attachments": []}
    try:
        hits = col.get(
            where={"$and": [{"wing": wing}, {"room": ATTACH_ROOM}]},
            include=["metadatas"],
        )
    except Exception as e:
        return {"attachments": [], "error": str(e)}
    counts: dict[str, int] = {}
    for m in hits.get("metadatas") or []:
        src = (m or {}).get("source_file", "") or ""
        if src.startswith("attachment://"):
            base = src.split("#", 1)[0].replace("attachment://", "")
            counts[base] = counts.get(base, 0) + 1
    return {
        "attachments": [
            {"filename": n, "chunks": c} for n, c in sorted(counts.items())
        ]
    }


@app.get("/api/stats")
async def palace_stats():
    col = _safe_collection()
    if col is None:
        return {"total": 0, "wings": {}, "rooms": {}, "palace_path": PALACE_PATH}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"total": 0, "wings": {}, "rooms": {}, "error": str(e)}
    wings: dict[str, int] = {}
    rooms: dict[str, int] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        r = (m or {}).get("room", "unknown")
        wings[w] = wings.get(w, 0) + 1
        rooms[r] = rooms.get(r, 0) + 1
    try:
        total = col.count()
    except Exception:
        total = len(all_meta)
    return {
        "total": total,
        "wings": wings,
        "rooms": rooms,
        "palace_path": PALACE_PATH,
    }


@app.get("/api/taxonomy")
async def palace_taxonomy():
    col = _safe_collection()
    if col is None:
        return {"taxonomy": {}}
    try:
        all_meta = col.get(include=["metadatas"]).get("metadatas") or []
    except Exception as e:
        return {"taxonomy": {}, "error": str(e)}
    tax: dict[str, dict[str, int]] = {}
    for m in all_meta:
        w = (m or {}).get("wing", "unknown")
        r = (m or {}).get("room", "unknown")
        tax.setdefault(w, {})
        tax[w][r] = tax[w].get(r, 0) + 1
    return {"taxonomy": tax}


@app.get("/api/drawers")
async def list_drawers(
    wing: Optional[str] = None,
    room: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    col = _safe_collection()
    if col is None:
        return {"drawers": [], "total": 0, "offset": offset, "limit": limit}
    where = None
    conditions = []
    if wing:
        conditions.append({"wing": wing})
    if room:
        conditions.append({"room": room})
    if len(conditions) == 1:
        where = conditions[0]
    elif len(conditions) > 1:
        where = {"$and": conditions}

    try:
        kwargs = {"include": ["documents", "metadatas"]}
        if where:
            kwargs["where"] = where
        result = col.get(**kwargs)
    except Exception as e:
        return {"drawers": [], "total": 0, "error": str(e)}

    ids = result.get("ids") or []
    docs = result.get("documents") or []
    metas = result.get("metadatas") or []

    rows = []
    needle = (q or "").lower().strip()
    for i, did in enumerate(ids):
        doc = docs[i] if i < len(docs) else ""
        meta = metas[i] if i < len(metas) else {}
        if needle and needle not in doc.lower():
            continue
        rows.append(
            {
                "drawer_id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "source_file": (meta or {}).get("source_file", ""),
                "filed_at": (meta or {}).get("filed_at", ""),
                "added_by": (meta or {}).get("added_by", ""),
                "preview": doc[:300] + ("…" if len(doc) > 300 else ""),
                "length": len(doc),
            }
        )
    rows.sort(key=lambda r: r["filed_at"], reverse=True)
    total = len(rows)
    return {
        "drawers": rows[offset : offset + limit],
        "total": total,
        "offset": offset,
        "limit": limit,
    }


@app.get("/api/drawers/{drawer_id}")
async def get_drawer(drawer_id: str):
    return tool_get_drawer(drawer_id)


@app.patch("/api/drawers/{drawer_id}")
async def update_drawer(drawer_id: str, body: DrawerUpdate):
    return tool_update_drawer(
        drawer_id, content=body.content, wing=body.wing, room=body.room
    )


@app.delete("/api/drawers/{drawer_id}")
async def delete_drawer(drawer_id: str):
    return tool_delete_drawer(drawer_id)


@app.post("/api/check-duplicate")
async def check_dupe(body: DupeCheckBody):
    return tool_check_duplicate(body.content, body.threshold)


@app.get("/api/kg/stats")
async def kg_stats_endpoint():
    return tool_kg_stats()


@app.get("/api/kg/query")
async def kg_query_endpoint(
    entity: str,
    as_of: Optional[str] = None,
    direction: str = "both",
):
    return tool_kg_query(entity, as_of=as_of, direction=direction)


@app.get("/api/kg/timeline")
async def kg_timeline_endpoint(entity: Optional[str] = None):
    return tool_kg_timeline(entity=entity)


@app.post("/api/kg/add")
async def kg_add_endpoint(body: KgAddBody):
    return tool_kg_add(
        body.subject,
        body.predicate,
        body.object,
        valid_from=body.valid_from,
        source_closet=body.source_closet,
    )


@app.post("/api/kg/invalidate")
async def kg_invalidate_endpoint(body: KgInvalidateBody):
    return tool_kg_invalidate(
        body.subject, body.predicate, body.object, ended=body.ended
    )


@app.get("/api/diary")
async def diary_read_endpoint(agent_name: str = "ollama-mempalace", last_n: int = 20):
    return tool_diary_read(agent_name, last_n=last_n)


@app.post("/api/diary")
async def diary_write_endpoint(body: DiaryWriteBody):
    return tool_diary_write(body.agent_name, body.entry, topic=body.topic)


@app.get("/api/aaak-spec")
async def aaak_spec_endpoint():
    return tool_get_aaak_spec()


@app.post("/api/reconnect")
async def reconnect_endpoint():
    return tool_reconnect()


@app.post("/api/tunnels")
async def create_tunnel_endpoint(body: TunnelCreateBody):
    return tool_create_tunnel(
        body.source_wing,
        body.source_room,
        body.target_wing,
        body.target_room,
        label=body.label,
    )


@app.get("/api/tunnels")
async def list_tunnels_endpoint(wing: Optional[str] = None):
    return tool_list_tunnels(wing=wing)


@app.delete("/api/tunnels/{tunnel_id}")
async def delete_tunnel_endpoint(tunnel_id: str):
    return tool_delete_tunnel(tunnel_id)


@app.get("/api/tunnels/follow")
async def follow_tunnels_endpoint(wing: str, room: str):
    return tool_follow_tunnels(wing, room)


@app.get("/api/recall")
async def l2_recall_endpoint(
    wing: Optional[str] = None,
    room: Optional[str] = None,
    n: int = 10,
):
    """Layer 2 — on-demand retrieval scoped to wing/room."""
    try:
        stack = MemoryStack(palace_path=PALACE_PATH)
        text = stack.recall(wing=wing, room=room, n_results=n)
        return {
            "text": text,
            "tokens_estimate": len(text) // 4,
            "wing": wing,
            "room": room,
        }
    except Exception as e:
        return {"text": "", "tokens_estimate": 0, "error": str(e)}


@app.post("/api/wings/{wing}/import-convos")
async def import_convos(wing: str, body: ConvoImportBody):
    """Import a folder of conversation exports into the wing.

    Shells out to the mempalace CLI which handles all the format-specific
    parsing (Claude Code JSONL, ChatGPT JSON, Slack exports, plain text).
    """
    try:
        wing = sanitize_name(wing, "wing")
    except ValueError as e:
        raise HTTPException(400, str(e))
    convo_dir = os.path.expanduser(body.path)
    if not os.path.isdir(convo_dir):
        raise HTTPException(400, f"Not a directory: {convo_dir}")

    cmd = [
        sys.executable,
        "-m",
        "mempalace",
        "mine",
        convo_dir,
        "--mode",
        "convos",
        "--wing",
        wing,
    ]
    if body.limit:
        cmd.extend(["--limit", str(body.limit)])

    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=600
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Mining timed out (10 min)")

    if result.returncode != 0:
        raise HTTPException(
            500,
            f"mempalace mine failed (rc={result.returncode}): "
            + (result.stderr or result.stdout)[-1500:],
        )

    return {
        "ok": True,
        "wing": wing,
        "stdout_tail": result.stdout[-2000:],
    }


@app.get("/api/recent")
async def recent_activity(limit: int = 20):
    col = _safe_collection()
    if col is None:
        return {"recent": []}
    try:
        result = col.get(include=["metadatas", "documents"])
    except Exception as e:
        return {"recent": [], "error": str(e)}
    ids = result.get("ids") or []
    metas = result.get("metadatas") or []
    docs = result.get("documents") or []
    rows = []
    for i, did in enumerate(ids):
        meta = metas[i] if i < len(metas) else {}
        doc = docs[i] if i < len(docs) else ""
        rows.append(
            {
                "drawer_id": did,
                "wing": (meta or {}).get("wing", ""),
                "room": (meta or {}).get("room", ""),
                "filed_at": (meta or {}).get("filed_at", ""),
                "added_by": (meta or {}).get("added_by", ""),
                "preview": doc[:200] + ("…" if len(doc) > 200 else ""),
            }
        )
    rows.sort(key=lambda r: r["filed_at"], reverse=True)
    return {"recent": rows[:limit]}


@app.delete("/api/chat-session/{session_id}")
async def delete_chat_session(session_id: str):
    """Delete every drawer tagged with this chat session's id."""
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    try:
        result = col.get(include=["metadatas"])
    except Exception as e:
        raise HTTPException(500, str(e))
    ids = result.get("ids") or []
    metas = result.get("metadatas") or []
    matched = [
        ids[i]
        for i, m in enumerate(metas)
        if session_id
        and session_id in (((m or {}).get("source_file") or ""))
    ]
    if not matched:
        return {"deleted": 0, "session_id": session_id}
    try:
        col.delete(ids=matched)
    except Exception as e:
        raise HTTPException(500, str(e))
    return {"deleted": len(matched), "session_id": session_id}


@app.delete("/api/wings/{wing}/attachments")
async def delete_attachment(wing: str, filename: str):
    col = _safe_collection()
    if col is None:
        raise HTTPException(404, "No palace yet")
    safe = _safe_filename(filename)
    try:
        hits = col.get(
            where={"$and": [{"wing": wing}, {"room": ATTACH_ROOM}]},
            include=["metadatas"],
        )
    except Exception as e:
        raise HTTPException(500, str(e))
    ids_all = hits.get("ids") or []
    metas = hits.get("metadatas") or []
    target_prefix = f"attachment://{safe}"
    matched = [
        ids_all[i]
        for i, m in enumerate(metas)
        if (m or {}).get("source_file", "").startswith(target_prefix)
    ]
    if not matched:
        raise HTTPException(404, f"No attachment {filename!r} in wing {wing!r}")
    col.delete(ids=matched)
    return {"deleted": len(matched), "filename": filename}


@app.get("/api/search")
async def debug_search(
    q: str,
    wing: Optional[str] = None,
    room: Optional[str] = None,
    n: int = 5,
):
    return search_memories(
        q, palace_path=PALACE_PATH, wing=wing, room=room, n_results=n
    )


@app.get("/api/identity")
async def get_identity():
    text = ""
    if IDENTITY_PATH.exists():
        text = IDENTITY_PATH.read_text(encoding="utf-8")
    return {"text": text, "path": str(IDENTITY_PATH)}


@app.put("/api/identity")
async def put_identity(body: IdentityBody):
    IDENTITY_PATH.parent.mkdir(parents=True, exist_ok=True)
    IDENTITY_PATH.write_text(body.text, encoding="utf-8")
    try:
        IDENTITY_PATH.chmod(0o600)
    except OSError:
        pass
    return {"ok": True, "bytes": len(body.text.encode("utf-8"))}


@app.delete("/api/identity")
async def delete_identity():
    if IDENTITY_PATH.exists():
        IDENTITY_PATH.unlink()
    return {"ok": True}


# ─── Voice input (Whisper) ────────────────────────────────────────────────

WHISPER_MODELS = {
    "tiny.en": "mlx-community/whisper-tiny.en-mlx",
    "base.en": "mlx-community/whisper-base.en-mlx-q4",
    "small.en": "mlx-community/whisper-small.en-mlx-q4",
    "medium.en": "mlx-community/whisper-medium.en-mlx-q4",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}


@app.post("/api/transcribe")
async def transcribe_endpoint(
    audio: UploadFile = File(...),
    model: str = "base.en",
):
    """Transcribe an uploaded audio blob (WAV recommended) via mlx-whisper."""
    repo = WHISPER_MODELS.get(model)
    if not repo:
        raise HTTPException(
            400, f"unknown whisper model {model!r}. one of: {list(WHISPER_MODELS)}"
        )

    raw = await audio.read()
    if not raw:
        raise HTTPException(400, "empty audio")
    if len(raw) > 50 * 1024 * 1024:
        raise HTTPException(413, "audio over 50MB cap")

    # Pick a sensible suffix so librosa/soundfile can sniff the format.
    ct = (audio.content_type or "").lower()
    if "wav" in ct or audio.filename and audio.filename.endswith(".wav"):
        suffix = ".wav"
    elif "webm" in ct:
        suffix = ".webm"
    elif "ogg" in ct:
        suffix = ".ogg"
    elif "mp3" in ct or "mpeg" in ct:
        suffix = ".mp3"
    else:
        suffix = ".wav"

    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()
        try:
            import mlx_whisper  # lazy import — heavy
        except ImportError as e:
            raise HTTPException(500, f"mlx-whisper not installed: {e}")
        try:
            result = mlx_whisper.transcribe(tmp.name, path_or_hf_repo=repo)
        except Exception as e:
            raise HTTPException(500, f"transcription failed: {e}")
        text = (result.get("text") or "").strip()
        return {
            "text": text,
            "language": result.get("language"),
            "model": model,
        }
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


# ─── Voice output (macOS `say`) ───────────────────────────────────────────


_VOICES_CACHE: Optional[list[dict]] = None


@app.get("/api/voices")
async def list_voices(lang_prefix: Optional[str] = "en"):
    """List available macOS TTS voices. Filter to a language prefix (default: en)."""
    global _VOICES_CACHE
    if _VOICES_CACHE is None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "say", "-v", "?", stdout=asyncio.subprocess.PIPE
            )
            out, _ = await proc.communicate()
        except FileNotFoundError:
            raise HTTPException(500, "macOS `say` command not found")
        voices: list[dict] = []
        for raw in out.decode("utf-8", errors="replace").splitlines():
            # Format: "Name              lang_LL    # comment"
            line = raw.rstrip()
            if not line:
                continue
            # Find the language code (xx_YY) — split on it for robustness with
            # voices that have spaces in their names ("Bad News", "Eddy (German …)")
            m = re.search(r"\s+([a-z]{2}_[A-Z]{2})\s+", line)
            if not m:
                continue
            name = line[: m.start()].strip()
            lang = m.group(1)
            comment = line[m.end():].lstrip("# ").strip()
            voices.append({"name": name, "lang": lang, "sample": comment})
        _VOICES_CACHE = voices
    voices = _VOICES_CACHE
    if lang_prefix:
        voices = [v for v in voices if v["lang"].startswith(lang_prefix)]
    voices.sort(key=lambda v: v["name"])
    return {"voices": voices}


@app.post("/api/speak")
async def speak(body: SpeakBody):
    """Synthesize text via macOS `say` and return a WAV blob."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 8000:
        # Cap so a runaway response can't tie up TTS forever
        text = text[:8000]

    voice = (body.voice or "Samantha").strip()
    # Sanitize: macOS voice names use letters, spaces, parens, accents.
    if any(c in voice for c in ("\n", "\r", "\x00")):
        raise HTTPException(400, "invalid voice name")

    aiff_fd, aiff_path = tempfile.mkstemp(suffix=".aiff")
    os.close(aiff_fd)
    wav_fd, wav_path = tempfile.mkstemp(suffix=".wav")
    os.close(wav_fd)

    try:
        say_args = ["say", "-v", voice, "-o", aiff_path]
        if body.rate and 80 <= body.rate <= 500:
            say_args += ["-r", str(body.rate)]
        say_args.append(text)
        proc = await asyncio.create_subprocess_exec(
            *say_args,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(500, f"say failed: {err.decode('utf-8', 'replace')[:200]}")

        # Convert AIFF → 16-bit mono PCM WAV @ 22050 Hz (broadly compatible)
        proc = await asyncio.create_subprocess_exec(
            "afconvert", "-f", "WAVE", "-d", "LEI16@22050", "-c", "1",
            aiff_path, wav_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise HTTPException(
                500, f"afconvert failed: {err.decode('utf-8', 'replace')[:200]}"
            )

        with open(wav_path, "rb") as f:
            data = f.read()
        return Response(content=data, media_type="audio/wav")
    finally:
        for p in (aiff_path, wav_path):
            try:
                os.unlink(p)
            except OSError:
                pass


# ─── Personas ─────────────────────────────────────────────────────────────
# personas.json holds *named* personas. The "default" persona is always
# present and reads its identity text from identity.txt — that's the file
# the welcome modal and Identity (Layer 0) editor in Settings already
# write to. Named personas live in personas.json with their own identity
# text and override the default identity when active for a session.


def _read_other_personas() -> list[dict]:
    if not PERSONAS_PATH.exists():
        return []
    try:
        data = json.loads(PERSONAS_PATH.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return [p for p in data if isinstance(p, dict) and p.get("name")]
    except Exception:
        pass
    return []


def _write_other_personas(personas: list[dict]) -> None:
    PERSONAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    PERSONAS_PATH.write_text(
        json.dumps(personas, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        PERSONAS_PATH.chmod(0o600)
    except OSError:
        pass


def _all_personas() -> list[dict]:
    """List of every persona, with 'default' synthesized from identity.txt."""
    default_text = ""
    if IDENTITY_PATH.exists():
        default_text = IDENTITY_PATH.read_text(encoding="utf-8")
    default = {
        "name": "default",
        "description": "your main identity (Layer 0 — edited via Settings)",
        "identity": default_text,
        "is_default": True,
    }
    return [default, *_read_other_personas()]


def _identity_for_persona(persona_name: Optional[str]) -> str:
    name = persona_name or "default"
    for p in _all_personas():
        if p["name"] == name:
            return (p.get("identity") or "").strip()
    # Persona name was set but no matching persona — fall back to default
    return (_all_personas()[0].get("identity") or "").strip()


@app.get("/api/personas")
async def list_personas():
    return {"personas": _all_personas()}


@app.post("/api/personas")
async def create_persona(body: PersonaBody):
    try:
        name = sanitize_name(body.name, "persona name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if name == "default":
        raise HTTPException(400, "use Settings → Identity to edit the default persona")
    personas = _read_other_personas()
    if any(p["name"] == name for p in personas):
        raise HTTPException(409, f"persona {name!r} already exists")
    new = {
        "name": name,
        "description": body.description or "",
        "identity": body.identity or "",
    }
    personas.append(new)
    _write_other_personas(personas)
    return new


@app.put("/api/personas/{old_name}")
async def update_persona(old_name: str, body: PersonaBody):
    if old_name == "default":
        raise HTTPException(400, "default persona is edited via Settings → Identity")
    try:
        new_name = sanitize_name(body.name, "persona name")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if new_name == "default":
        raise HTTPException(400, "cannot rename a persona to 'default'")
    personas = _read_other_personas()
    for i, p in enumerate(personas):
        if p["name"] == old_name:
            # Disallow rename collision
            if new_name != old_name and any(
                q["name"] == new_name for q in personas
            ):
                raise HTTPException(409, f"persona {new_name!r} already exists")
            personas[i] = {
                "name": new_name,
                "description": body.description or "",
                "identity": body.identity or "",
            }
            _write_other_personas(personas)
            return personas[i]
    raise HTTPException(404, f"persona {old_name!r} not found")


@app.delete("/api/personas/{name}")
async def delete_persona(name: str):
    if name == "default":
        raise HTTPException(400, "cannot delete the default persona")
    personas = _read_other_personas()
    new = [p for p in personas if p["name"] != name]
    if len(new) == len(personas):
        raise HTTPException(404, f"persona {name!r} not found")
    _write_other_personas(new)
    return {"ok": True, "deleted": name}


@app.get("/api/wakeup")
async def get_wakeup(wing: Optional[str] = None):
    try:
        stack = MemoryStack(palace_path=PALACE_PATH)
        text = stack.wake_up(wing=wing)
        return {"text": text, "tokens_estimate": len(text) // 4, "wing": wing}
    except Exception as e:
        return {"text": "", "tokens_estimate": 0, "wing": wing, "error": str(e)}


# ─── Tool calling (OpenAI-style schemas; Ollama forwards these verbatim) ────

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "memory_search",
            "description": (
                "Search the user's palace for prior memories relevant to a query. "
                "Call this BEFORE answering anything about the user's past "
                "conversations, preferences, projects, or people. "
                "Do not guess — verify by searching first."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query to search for.",
                    },
                    "wing": {
                        "type": "string",
                        "description": "Optional wing to scope the search. Defaults to the current wing.",
                    },
                    "n": {
                        "type": "integer",
                        "description": "Max results to return (1-10). Default 5.",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_query",
            "description": (
                "Query the knowledge graph for what you know about an entity "
                "(a person, project, or thing). Returns typed, time-aware facts. "
                "Use this before claiming facts about someone or something."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "entity": {
                        "type": "string",
                        "description": "The entity name to query (e.g. 'Alex', 'dos-clone').",
                    },
                    "as_of": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD; only facts valid at this date.",
                    },
                },
                "required": ["entity"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_add",
            "description": (
                "Record a new fact in the knowledge graph as subject → predicate → object. "
                "Use when the user states a durable fact, preference, or decision "
                "(e.g. 'I prefer dark mode', 'Alex works at X')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {
                        "type": "string",
                        "description": "snake_case relationship, e.g. 'works_on', 'prefers', 'lives_in'.",
                    },
                    "object": {"type": "string"},
                    "valid_from": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD when the fact became true.",
                    },
                },
                "required": ["subject", "predicate", "object"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "kg_invalidate",
            "description": (
                "Mark a prior fact as no longer true (e.g. user used to prefer X, now prefers Y). "
                "Call with the OLD fact's subject/predicate/object to expire it, then kg_add the new fact."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {"type": "string"},
                    "object": {"type": "string"},
                    "ended": {
                        "type": "string",
                        "description": "Optional YYYY-MM-DD when the fact stopped being true.",
                    },
                },
                "required": ["subject", "predicate", "object"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "diary_write",
            "description": (
                "Write a short reflection to the agent's own journal. "
                "Use at natural breakpoints (after a meaningful exchange, when you learn "
                "something worth remembering, or when the user says 'remember this'). "
                "Keep entries brief and first-person."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "entry": {"type": "string"},
                    "topic": {
                        "type": "string",
                        "description": "Optional short tag (reflection, observation, todo, decision).",
                    },
                },
                "required": ["entry"],
            },
        },
    },
]

TOOL_PROTOCOL = (
    "You have tools available. Use them proactively:\n"
    "- BEFORE answering about the user's past (preferences, people, projects, "
    "past decisions, events), call memory_search and/or kg_query FIRST. Never guess.\n"
    "- When the user states a durable fact, preference, or decision, call kg_add.\n"
    "- When something the user said before has changed, call kg_invalidate on the "
    "old fact, then kg_add the new one.\n"
    "- After a meaningful exchange, optionally call diary_write with a brief "
    "first-person reflection.\n"
    "Use tools silently — don't narrate 'I'm calling a tool'. Your text reply "
    "should read naturally."
)


def _exec_tool(
    name: str, raw_args, current_wing: str, session_id: Optional[str]
) -> dict:
    """Dispatch a tool call. Returns a JSON-serializable dict."""
    if isinstance(raw_args, str):
        try:
            args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            return {"error": f"invalid JSON arguments: {raw_args[:200]}"}
    elif isinstance(raw_args, dict):
        args = raw_args
    else:
        args = {}

    try:
        if name == "memory_search":
            q = str(args.get("query") or "").strip()
            if not q:
                return {"error": "query is required"}
            wing = args.get("wing") or current_wing
            n = max(1, min(int(args.get("n", 5)), 10))
            result = search_memories(
                q, palace_path=PALACE_PATH, wing=wing, n_results=n
            )
            hits = result.get("results", []) or []
            return {
                "count": len(hits),
                "hits": [
                    {
                        "wing": h.get("wing"),
                        "room": h.get("room"),
                        "similarity": h.get("similarity"),
                        "text": (h.get("text") or "")[:600],
                    }
                    for h in hits
                ],
            }
        if name == "kg_query":
            entity = str(args.get("entity") or "").strip()
            if not entity:
                return {"error": "entity is required"}
            return tool_kg_query(entity, as_of=args.get("as_of"))
        if name == "kg_add":
            subj = str(args.get("subject") or "").strip()
            pred = str(args.get("predicate") or "").strip()
            obj = str(args.get("object") or "").strip()
            if not (subj and pred and obj):
                return {"error": "subject, predicate, object are all required"}
            return tool_kg_add(
                subj, pred, obj, valid_from=args.get("valid_from")
            )
        if name == "kg_invalidate":
            subj = str(args.get("subject") or "").strip()
            pred = str(args.get("predicate") or "").strip()
            obj = str(args.get("object") or "").strip()
            if not (subj and pred and obj):
                return {"error": "subject, predicate, object are all required"}
            return tool_kg_invalidate(subj, pred, obj, ended=args.get("ended"))
        if name == "diary_write":
            entry = str(args.get("entry") or "").strip()
            if not entry:
                return {"error": "entry is required"}
            return tool_diary_write(
                "ollama-mempalace",
                entry,
                topic=str(args.get("topic") or "general"),
            )
        return {"error": f"unknown tool: {name}"}
    except Exception as e:
        return {"error": str(e)}


MAX_TOOL_ITERATIONS = 6


def _estimate_tokens(text: str) -> int:
    """Rough char-based token estimate. ~4 chars per token for English."""
    return max(1, len(text) // 4)


def _estimate_messages_tokens(messages: list[dict]) -> int:
    """Sum estimated tokens across a message list, accounting for content + images."""
    total = 0
    for m in messages:
        c = m.get("content") or ""
        total += _estimate_tokens(c) + 4  # 4-token overhead per message
        if m.get("images"):
            # Vision encoding cost varies wildly; rough overhead per image
            total += 600 * len(m["images"])
    return total


async def _summarize_messages(model: str, messages: list[dict]) -> str:
    """Ask the same model to summarize older messages. Returns plain text summary."""
    if not messages:
        return ""
    convo = "\n\n".join(
        f"{m.get('role', '?').upper()}: {m.get('content', '')}" for m in messages
    )
    prompt = (
        "Summarize the following conversation in under 300 words. "
        "Preserve all key facts, decisions, named people/projects, and any "
        "unresolved questions. Use bullet points. Don't add preamble.\n\n"
        f"{convo}"
    )
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                },
            )
            r.raise_for_status()
            return (r.json().get("message", {}) or {}).get("content", "").strip()
    except Exception:
        return ""


async def _maybe_compact(
    req: ChatRequest, system_messages: list[dict], chat_messages: list[dict]
) -> tuple[list[dict], Optional[dict]]:
    """If the prompt would exceed budget, summarize older chat messages.

    Returns (possibly-compacted chat_messages, optional summary-event dict).
    System messages are NEVER compacted — only user/assistant turns.
    """
    if not req.auto_compact:
        return chat_messages, None
    try:
        info = await model_info(req.model)
        ctx = int(info.get("context_length") or 4096)
    except Exception:
        ctx = 4096
    budget = int(ctx * req.context_budget_pct)
    overhead = _estimate_messages_tokens(system_messages)
    body_tokens = _estimate_messages_tokens(chat_messages)
    if overhead + body_tokens <= budget:
        return chat_messages, None

    keep_recent = req.keep_recent_turns * 2  # user+assistant pairs
    if len(chat_messages) <= keep_recent + 1:
        return chat_messages, None  # nothing safe to compact

    older = chat_messages[:-keep_recent]
    recent = chat_messages[-keep_recent:]
    summary = await _summarize_messages(req.model, older)
    if not summary:
        return chat_messages, None  # summarization failed; send as-is

    summary_msg = {
        "role": "system",
        "content": (
            "Summary of earlier conversation (older turns were compacted to save "
            "context window):\n\n" + summary
        ),
    }
    new_chat = [summary_msg, *recent]
    saved = body_tokens - _estimate_messages_tokens(new_chat)
    event = {
        "type": "compacted",
        "summarized_turns": len(older),
        "kept_turns": len(recent),
        "tokens_saved_estimate": saved,
        "context_length": ctx,
    }
    return new_chat, event


def _format_memory_block(hits: list[dict]) -> str:
    if not hits:
        return ""
    parts = [
        "You have access to relevant memories from prior conversations with this user. "
        "Use them when they help; ignore them when they don't. Do not mention this block exists."
    ]
    for i, h in enumerate(hits, 1):
        wing = h.get("wing", "?")
        room = h.get("room", "?")
        sim = h.get("similarity", 0)
        text = (h.get("text") or "").strip()
        parts.append(f"\n[memory {i} | {wing}/{room} | similarity={sim}]\n{text}")
    parts.append("\n--- end memories ---")
    return "\n".join(parts)


async def _extract_kg_triples(model: str, transcript: str) -> list[dict]:
    """Use a small fast LLM to pull subject/predicate/object triples from a transcript."""
    prompt = (
        "Extract every durable fact from the following conversation. Output a "
        "JSON object with a single key 'triples' whose value is an array of "
        "{subject, predicate, object} triples.\n\n"
        "Include facts that are:\n"
        "- About specific named people, projects, products, places, or things\n"
        "- Stated as true (not asked, hypothesized, or denied)\n"
        "- Not obvious or trivial\n\n"
        "Be EXHAUSTIVE — if one sentence has 3 facts, emit 3 triples.\n\n"
        "Use snake_case predicates (works_on, prefers, lives_in, owns, decided, "
        "switched_to, started, finished, met, produces, founded, created).\n\n"
        "Output shape: {\"triples\": [{\"subject\":\"...\",\"predicate\":\"...\",\"object\":\"...\"}]}\n"
        "Empty list if nothing qualifies. No preamble, no markdown.\n\n"
        f"Conversation:\n{transcript}"
    )
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{OLLAMA_HOST}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                },
            )
            r.raise_for_status()
            text = (r.json().get("message", {}) or {}).get("content", "").strip()
    except Exception:
        return []
    if not text:
        return []
    # Tolerate either {"triples": [...]} or [...] shape since some models wrap.
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Try to find a JSON array inside the text
        m = re.search(r"\[.*\]", text, re.DOTALL)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except json.JSONDecodeError:
            return []
    if isinstance(data, dict):
        # Common wrapping keys
        for k in ("triples", "facts", "results", "items"):
            if k in data and isinstance(data[k], list):
                data = data[k]
                break
        else:
            # Model returned a single triple as a flat dict — wrap it
            if all(k in data for k in ("subject", "predicate", "object")):
                data = [data]
            else:
                return []
    if not isinstance(data, list):
        return []
    out = []
    for t in data:
        if not isinstance(t, dict):
            continue
        s = str(t.get("subject", "")).strip()
        p = str(t.get("predicate", "")).strip()
        o = str(t.get("object", "")).strip()
        if not (s and p and o):
            continue
        out.append({"subject": s, "predicate": p, "object": o})
    return out


def _run_auto_extract(transcript: str, wing: str) -> list[dict]:
    """Extract facts from a transcript and file each as its own drawer.

    Default 0.3 confidence misses single-paragraph user turns; 0.15 catches
    typical "I prefer..." / "I decided..." statements without becoming noisy.
    """
    try:
        memories = extract_memories(transcript, min_confidence=0.15)
    except Exception:
        return []
    saved: list[dict] = []
    for m in memories:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        mem_type = (m.get("memory_type") or "fact").strip().lower()
        room = HALL_FOR_MEMORY_TYPE.get(mem_type)
        if not room:
            candidate = f"hall_{mem_type}"
            room = candidate if re.match(r"^hall_[a-z_]+$", candidate) else FACTS_ROOM
        try:
            r = tool_add_drawer(
                wing=wing,
                room=room,
                content=content,
                source_file=f"extract://{datetime.now().isoformat()}",
                added_by="auto-extract",
            )
            if r.get("success"):
                saved.append({"room": room, "type": mem_type, "preview": content[:120]})
        except Exception:
            continue
    return saved


@app.post("/api/chat")
async def chat(req: ChatRequest):
    try:
        wing = sanitize_name(req.wing or DEFAULT_WING, "wing")
        room = sanitize_name(req.room or DEFAULT_ROOM, "room")
    except ValueError as e:
        raise HTTPException(400, str(e))

    last_user = next((m for m in reversed(req.messages) if m.role == "user"), None)

    memory_hits: list[dict] = []
    if req.use_memory and last_user:
        try:
            result = search_memories(
                last_user.content,
                palace_path=PALACE_PATH,
                wing=wing,
                n_results=req.memory_limit,
            )
            memory_hits = result.get("results", []) or []
        except Exception:
            memory_hits = []

    out_messages: list[dict] = []

    # System prompts compose top-down: identity first, per-wing prompt next, memory last.
    if req.use_identity:
        identity = _identity_for_persona(req.persona)
        if identity:
            out_messages.append({"role": "system", "content": identity})

    if req.system_prompt and req.system_prompt.strip():
        out_messages.append({"role": "system", "content": req.system_prompt.strip()})

    if req.enable_tools:
        out_messages.append({"role": "system", "content": TOOL_PROTOCOL})

    memory_block = _format_memory_block(memory_hits)
    if memory_block:
        out_messages.append({"role": "system", "content": memory_block})

    chat_msgs: list[dict] = []
    for m in req.messages:
        msg_dict: dict = {"role": m.role, "content": m.content}
        if m.images:
            msg_dict["images"] = m.images
        chat_msgs.append(msg_dict)

    # Compaction pass — only on chat messages, never on system prompts above.
    chat_msgs, compaction_event = await _maybe_compact(req, out_messages, chat_msgs)
    out_messages.extend(chat_msgs)

    async def generate():
        meta = {
            "type": "memory_hits",
            "wing": wing,
            "room": room,
            "hits": [
                {
                    "wing": h.get("wing"),
                    "room": h.get("room"),
                    "source": h.get("source_file"),
                    "similarity": h.get("similarity"),
                    "preview": (h.get("text") or "")[:400],
                }
                for h in memory_hits
            ],
        }
        yield f"data: {json.dumps(meta)}\n\n"
        if compaction_event:
            yield f"data: {json.dumps(compaction_event)}\n\n"

        full_response = ""
        try:
            if req.enable_tools:
                # Tool-enabled turn: non-streaming loop so tool_calls arrive intact.
                async with httpx.AsyncClient(timeout=None) as client:
                    current = list(out_messages)
                    for _ in range(MAX_TOOL_ITERATIONS):
                        r = await client.post(
                            f"{OLLAMA_HOST}/api/chat",
                            json={
                                "model": req.model,
                                "messages": current,
                                "tools": TOOLS,
                                "stream": False,
                            },
                        )
                        if r.status_code != 200:
                            try:
                                err = r.json().get("error") or r.text[:500]
                            except Exception:
                                err = r.text[:500]
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "error",
                                        "message": f"Ollama {r.status_code}: {err}",
                                    }
                                )
                                + "\n\n"
                            )
                            return
                        data = r.json()
                        msg_out = (data or {}).get("message", {}) or {}
                        tool_calls = msg_out.get("tool_calls") or []
                        assistant_text = msg_out.get("content", "") or ""
                        thinking_text = msg_out.get("thinking", "") or ""
                        if thinking_text:
                            yield (
                                "data: "
                                + json.dumps(
                                    {"type": "thinking", "content": thinking_text}
                                )
                                + "\n\n"
                            )

                        if not tool_calls:
                            full_response = assistant_text
                            if assistant_text:
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {"type": "token", "content": assistant_text}
                                    )
                                    + "\n\n"
                                )
                            break

                        # Record the assistant's tool-call message in the history
                        current.append(
                            {
                                "role": "assistant",
                                "content": assistant_text,
                                "tool_calls": tool_calls,
                            }
                        )

                        for tc in tool_calls:
                            fn = (tc or {}).get("function") or {}
                            name = fn.get("name") or "unknown"
                            raw_args = fn.get("arguments")
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "tool_call",
                                        "name": name,
                                        "arguments": raw_args,
                                    }
                                )
                                + "\n\n"
                            )
                            result = _exec_tool(
                                name, raw_args, wing, req.session_id
                            )
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "tool_result",
                                        "name": name,
                                        "result": result,
                                    }
                                )
                                + "\n\n"
                            )
                            current.append(
                                {
                                    "role": "tool",
                                    "name": name,
                                    "content": json.dumps(result),
                                }
                            )
                    else:
                        # Hit iteration cap
                        yield (
                            "data: "
                            + json.dumps(
                                {
                                    "type": "error",
                                    "message": f"tool loop exceeded {MAX_TOOL_ITERATIONS} iterations",
                                }
                            )
                            + "\n\n"
                        )
            else:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "POST",
                        f"{OLLAMA_HOST}/api/chat",
                        json={
                            "model": req.model,
                            "messages": out_messages,
                            "stream": True,
                        },
                    ) as r:
                        if r.status_code != 200:
                            body = await r.aread()
                            try:
                                err = json.loads(body.decode("utf-8")).get(
                                    "error"
                                ) or body.decode("utf-8")[:500]
                            except Exception:
                                err = body.decode("utf-8", errors="replace")[:500]
                            yield (
                                "data: "
                                + json.dumps(
                                    {
                                        "type": "error",
                                        "message": f"Ollama {r.status_code}: {err}",
                                    }
                                )
                                + "\n\n"
                            )
                            return
                        async for line in r.aiter_lines():
                            if not line:
                                continue
                            try:
                                chunk = json.loads(line)
                            except json.JSONDecodeError:
                                continue
                            if chunk.get("error"):
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {
                                            "type": "error",
                                            "message": f"Ollama: {chunk['error']}",
                                        }
                                    )
                                    + "\n\n"
                                )
                                return
                            msg = chunk.get("message", {}) or {}
                            thinking = msg.get("thinking", "")
                            if thinking:
                                yield (
                                    "data: "
                                    + json.dumps(
                                        {
                                            "type": "thinking",
                                            "content": thinking,
                                        }
                                    )
                                    + "\n\n"
                                )
                            token = msg.get("content", "")
                            if token:
                                full_response += token
                                yield f"data: {json.dumps({'type': 'token', 'content': token})}\n\n"
                            if chunk.get("done"):
                                break
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
            return

        saved_id: Optional[str] = None
        save_error: Optional[str] = None
        extracted_facts: list[dict] = []

        if req.save_to_memory and last_user and full_response.strip():
            transcript = (
                f"User: {last_user.content}\n\nAssistant: {full_response.strip()}"
            )
            try:
                result = tool_add_drawer(
                    wing=wing,
                    room=room,
                    content=transcript,
                    source_file=(
                        f"chat://{req.model}/{req.session_id or 'no-session'}"
                        f"/{datetime.now().isoformat()}"
                    ),
                    added_by="ollama-mempalace",
                )
                if result.get("success"):
                    saved_id = result.get("drawer_id")
                else:
                    save_error = result.get("error", "unknown error")
            except Exception as e:
                save_error = str(e)

            if req.auto_extract:
                extracted_facts = _run_auto_extract(transcript, wing)

            kg_added: list[dict] = []
            if req.auto_kg:
                kg_model = req.auto_kg_model or req.model
                triples = await _extract_kg_triples(kg_model, transcript)
                for t in triples:
                    try:
                        result = tool_kg_add(
                            t["subject"],
                            t["predicate"],
                            t["object"],
                        )
                        if result.get("success"):
                            kg_added.append(t)
                    except Exception:
                        continue

        yield (
            "data: "
            + json.dumps(
                {
                    "type": "done",
                    "saved_drawer_id": saved_id,
                    "save_error": save_error,
                    "extracted_facts": extracted_facts,
                    "kg_added": kg_added if req.auto_kg else [],
                }
            )
            + "\n\n"
        )

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

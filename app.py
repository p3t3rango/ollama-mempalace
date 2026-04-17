"""ollama-mempalace — local chat UI that wires Ollama models to MemPalace memory."""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from mempalace.config import MempalaceConfig, sanitize_name
from mempalace.mcp_server import tool_add_drawer
from mempalace.palace import get_collection
from mempalace.searcher import search_memories

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
DEFAULT_ROOM = "general"
DEFAULT_WING = "personal"

config = MempalaceConfig()
config.init()
PALACE_PATH = config.palace_path
Path(PALACE_PATH).mkdir(parents=True, exist_ok=True)

app = FastAPI(title="ollama-mempalace")
STATIC_DIR = Path(__file__).parent / "static"


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str
    wing: str = DEFAULT_WING
    room: str = DEFAULT_ROOM
    messages: list[Message]
    use_memory: bool = True
    save_to_memory: bool = True
    memory_limit: int = Field(default=5, ge=1, le=20)


class WingRenameBody(BaseModel):
    new_name: str


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
    memory_block = _format_memory_block(memory_hits)
    if memory_block:
        out_messages.append({"role": "system", "content": memory_block})
    for m in req.messages:
        out_messages.append({"role": m.role, "content": m.content})

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

        full_response = ""
        try:
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
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        msg = chunk.get("message", {}) or {}
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
        if req.save_to_memory and last_user and full_response.strip():
            transcript = (
                f"User: {last_user.content}\n\nAssistant: {full_response.strip()}"
            )
            try:
                result = tool_add_drawer(
                    wing=wing,
                    room=room,
                    content=transcript,
                    source_file=f"chat://{req.model}/{datetime.now().isoformat()}",
                    added_by="ollama-mempalace",
                )
                if result.get("success"):
                    saved_id = result.get("drawer_id")
                else:
                    save_error = result.get("error", "unknown error")
            except Exception as e:
                save_error = str(e)

        yield (
            "data: "
            + json.dumps(
                {
                    "type": "done",
                    "saved_drawer_id": saved_id,
                    "save_error": save_error,
                }
            )
            + "\n\n"
        )

    return StreamingResponse(generate(), media_type="text/event-stream")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="info")

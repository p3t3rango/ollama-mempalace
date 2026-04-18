"""MCP stdio server exposing the palace as a Model Context Protocol service.

Wire it to Claude Desktop, Cursor, Codex, or any other MCP-aware client by
adding to that client's MCP config. Example for Claude Desktop
(~/Library/Application Support/Claude/claude_desktop_config.json):

    {
      "mcpServers": {
        "mempalace": {
          "command": "/Users/peterarango/cursor experiments/ollama-mempalace/.venv/bin/python",
          "args": [
            "/Users/peterarango/cursor experiments/ollama-mempalace/mcp_stdio.py"
          ]
        }
      }
    }

The server speaks MCP protocol version 2024-11-05 over stdin/stdout. All
log lines go to stderr to keep the protocol stream clean. Tools mirror the
five we already expose to Ollama via the chat tool-call loop:
  - memory_search
  - kg_query
  - kg_add
  - kg_invalidate
  - diary_write

Plus two read-only resources:
  - palace://stats
  - palace://taxonomy
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback
from typing import Any

# Redirect any noisy startup output to stderr so it doesn't corrupt the
# stdio JSON-RPC stream.
_real_stdout = sys.stdout
sys.stdout = sys.stderr

# Reuse the same tool wiring as the FastAPI app — this guarantees the MCP
# server and the in-app tool-call loop behave identically.
from app import (  # noqa: E402
    PALACE_PATH,
    TOOLS,
    _exec_tool,
    _safe_collection,
    tool_kg_stats,
)

sys.stdout = _real_stdout

PROTOCOL_VERSION = "2024-11-05"
SERVER_NAME = "ollama-mempalace"
SERVER_VERSION = "1.0.0"


def log(msg: str) -> None:
    """Stderr-only logger so we never corrupt the stdout JSON-RPC stream."""
    print(f"[mcp] {msg}", file=sys.stderr, flush=True)


# ─── JSON-RPC framing ─────────────────────────────────────────────────────


def make_response(req_id, result) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def make_error(req_id, code: int, message: str, data: Any = None) -> dict:
    err: dict = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": "2.0", "id": req_id, "error": err}


# ─── Method handlers ──────────────────────────────────────────────────────


def handle_initialize(params: dict) -> dict:
    return {
        "protocolVersion": PROTOCOL_VERSION,
        "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        "capabilities": {
            "tools": {},
            "resources": {},
        },
    }


def handle_tools_list(_params: dict) -> dict:
    """Map our OpenAI-style tool schemas to MCP tool descriptors."""
    tools = []
    for t in TOOLS:
        fn = t.get("function", {})
        tools.append(
            {
                "name": fn.get("name"),
                "description": fn.get("description", ""),
                "inputSchema": fn.get("parameters", {"type": "object"}),
            }
        )
    return {"tools": tools}


def handle_tools_call(params: dict) -> dict:
    name = params.get("name") or ""
    args = params.get("arguments") or {}
    # Default wing/session_id when invoked from an external client.
    result = _exec_tool(name, args, current_wing="personal", session_id=None)
    return {
        "content": [
            {"type": "text", "text": json.dumps(result, indent=2, ensure_ascii=False)}
        ],
        "isError": bool(isinstance(result, dict) and result.get("error")),
    }


def handle_resources_list(_params: dict) -> dict:
    return {
        "resources": [
            {
                "uri": "palace://stats",
                "name": "Palace stats",
                "description": "Total drawers, wing and room counts, palace path",
                "mimeType": "application/json",
            },
            {
                "uri": "palace://taxonomy",
                "name": "Wing → room taxonomy",
                "description": "Tree of wings to rooms with drawer counts",
                "mimeType": "application/json",
            },
            {
                "uri": "palace://kg/stats",
                "name": "Knowledge graph stats",
                "description": "Entity, triple, and relationship counts",
                "mimeType": "application/json",
            },
        ]
    }


def handle_resources_read(params: dict) -> dict:
    uri = params.get("uri") or ""
    payload: Any
    if uri == "palace://stats":
        col = _safe_collection()
        if col is None:
            payload = {"total": 0, "wings": {}, "rooms": {}, "palace_path": PALACE_PATH}
        else:
            metas = col.get(include=["metadatas"]).get("metadatas") or []
            wings: dict[str, int] = {}
            rooms: dict[str, int] = {}
            for m in metas:
                wings[(m or {}).get("wing", "?")] = (
                    wings.get((m or {}).get("wing", "?"), 0) + 1
                )
                rooms[(m or {}).get("room", "?")] = (
                    rooms.get((m or {}).get("room", "?"), 0) + 1
                )
            payload = {
                "total": col.count(),
                "wings": wings,
                "rooms": rooms,
                "palace_path": PALACE_PATH,
            }
    elif uri == "palace://taxonomy":
        col = _safe_collection()
        tax: dict = {}
        if col is not None:
            metas = col.get(include=["metadatas"]).get("metadatas") or []
            for m in metas:
                w = (m or {}).get("wing", "?")
                r = (m or {}).get("room", "?")
                tax.setdefault(w, {})
                tax[w][r] = tax[w].get(r, 0) + 1
        payload = {"taxonomy": tax}
    elif uri == "palace://kg/stats":
        payload = tool_kg_stats()
    else:
        raise ValueError(f"unknown resource uri: {uri}")
    return {
        "contents": [
            {
                "uri": uri,
                "mimeType": "application/json",
                "text": json.dumps(payload, indent=2, ensure_ascii=False),
            }
        ]
    }


HANDLERS = {
    "initialize": handle_initialize,
    "tools/list": handle_tools_list,
    "tools/call": handle_tools_call,
    "resources/list": handle_resources_list,
    "resources/read": handle_resources_read,
    # Notifications — silently accepted, no response.
    "notifications/initialized": lambda _p: None,
    "notifications/cancelled": lambda _p: None,
    # Optional methods we don't implement yet but won't error on
    "prompts/list": lambda _p: {"prompts": []},
}


# ─── Main loop ────────────────────────────────────────────────────────────


async def serve() -> None:
    log(f"starting MCP server. palace={PALACE_PATH}")
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            log("stdin closed; exiting")
            return
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            log(f"bad json: {e!r}; line={line[:200]!r}")
            continue

        method = req.get("method")
        req_id = req.get("id")
        params = req.get("params") or {}

        # Notifications (no id) get no response
        is_notification = req_id is None

        handler = HANDLERS.get(method)
        if handler is None:
            if not is_notification:
                _emit(make_error(req_id, -32601, f"Method not found: {method}"))
            else:
                log(f"ignoring unknown notification: {method}")
            continue

        try:
            result = handler(params)
        except Exception as e:
            log(f"handler error in {method}: {e!r}\n{traceback.format_exc()}")
            if not is_notification:
                _emit(make_error(req_id, -32603, str(e)))
            continue

        if not is_notification:
            _emit(make_response(req_id, result))


def _emit(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        asyncio.run(serve())
    except (KeyboardInterrupt, BrokenPipeError):
        pass

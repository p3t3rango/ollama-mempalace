"""Minimal MCP client — connect to external MCP servers as subprocesses.

We act as a JSON-RPC 2.0 client over stdio. One MCPClient instance per
external server. Subprocesses are spawned lazily on first use and kept
alive across requests to avoid per-call initialize overhead.

Used by app.py to merge external tool schemas into the chat tool-call
loop. External tool names are prefixed `mcp__<server>__<tool>` so they
don't collide with our internal ones (memory_search, kg_*, diary_write).
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

PROTOCOL_VERSION = "2024-11-05"
CLIENT_NAME = "ollama-mempalace"
CLIENT_VERSION = "1.0.0"

CONFIG_PATH = Path(os.path.expanduser("~/.mempalace/mcp_clients.json"))


# ─── On-disk config ───────────────────────────────────────────────────────


def load_config() -> dict[str, dict]:
    if not CONFIG_PATH.exists():
        return {}
    try:
        data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def save_config(cfg: dict[str, dict]) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    try:
        CONFIG_PATH.chmod(0o600)
    except OSError:
        pass


# ─── One client per external server ───────────────────────────────────────


@dataclass
class MCPClient:
    name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    # Runtime state — not persisted
    proc: Optional[asyncio.subprocess.Process] = None
    next_id: int = 1
    pending: dict[int, asyncio.Future] = field(default_factory=dict)
    tools: list[dict] = field(default_factory=list)
    resources: list[dict] = field(default_factory=list)
    last_error: Optional[str] = None
    _reader_task: Optional[asyncio.Task] = None
    _start_lock: Optional[asyncio.Lock] = None

    def __post_init__(self) -> None:
        self._start_lock = asyncio.Lock()

    @property
    def is_running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def start(self) -> None:
        """Spawn the subprocess, do MCP handshake, fetch tool + resource lists."""
        async with self._start_lock:  # type: ignore[union-attr]
            if self.is_running:
                return
            self.last_error = None
            full_env = {**os.environ, **(self.env or {})}
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    self.command,
                    *self.args,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=full_env,
                )
            except FileNotFoundError as e:
                self.last_error = f"command not found: {self.command} ({e})"
                raise
            self._reader_task = asyncio.create_task(self._read_loop())

            # Initialize
            init_result = await self._request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": CLIENT_NAME, "version": CLIENT_VERSION},
                },
                timeout=15.0,
            )
            # Send initialized notification
            await self._notify("notifications/initialized", {})

            # Fetch tools + resources (best-effort)
            try:
                tools_resp = await self._request("tools/list", {}, timeout=10.0)
                self.tools = tools_resp.get("tools", []) or []
            except Exception:
                self.tools = []
            try:
                res_resp = await self._request("resources/list", {}, timeout=10.0)
                self.resources = res_resp.get("resources", []) or []
            except Exception:
                self.resources = []

    async def stop(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):
                pass
            self._reader_task = None
        if self.proc and self.proc.returncode is None:
            try:
                self.proc.terminate()
                await asyncio.wait_for(self.proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                self.proc.kill()
            except Exception:
                pass
        self.proc = None
        # Cancel any pending requests
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("MCP client stopped"))
        self.pending.clear()

    async def call_tool(self, tool_name: str, args: dict) -> dict:
        """Invoke a tool on this server. Lazy-starts the subprocess."""
        if not self.is_running:
            await self.start()
        result = await self._request(
            "tools/call",
            {"name": tool_name, "arguments": args or {}},
            timeout=120.0,
        )
        return result

    # ─── Internals ────────────────────────────────────────────────────────

    async def _request(self, method: str, params: dict, timeout: float = 30.0) -> Any:
        if self.proc is None or self.proc.stdin is None:
            raise RuntimeError(f"MCP client {self.name!r} not started")
        req_id = self.next_id
        self.next_id += 1
        msg = {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self.pending[req_id] = fut
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
            await self.proc.stdin.drain()
        except Exception as e:
            self.pending.pop(req_id, None)
            raise RuntimeError(f"MCP write failed: {e}") from e
        try:
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.pending.pop(req_id, None)
            raise RuntimeError(f"MCP request {method} timed out after {timeout}s")

    async def _notify(self, method: str, params: dict) -> None:
        if self.proc is None or self.proc.stdin is None:
            return
        msg = {"jsonrpc": "2.0", "method": method, "params": params}
        try:
            self.proc.stdin.write((json.dumps(msg) + "\n").encode("utf-8"))
            await self.proc.stdin.drain()
        except Exception:
            pass

    async def _read_loop(self) -> None:
        """Read JSON-RPC frames from the subprocess stdout, resolve pending futures."""
        if self.proc is None or self.proc.stdout is None:
            return
        try:
            while True:
                line = await self.proc.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode("utf-8"))
                except json.JSONDecodeError:
                    continue
                req_id = msg.get("id")
                if req_id is None:
                    # Notification from server — ignore for now
                    continue
                fut = self.pending.pop(req_id, None)
                if fut is None or fut.done():
                    continue
                if "error" in msg:
                    err = msg["error"]
                    fut.set_exception(
                        RuntimeError(
                            f"MCP error {err.get('code')}: {err.get('message')}"
                        )
                    )
                else:
                    fut.set_result(msg.get("result", {}))
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self.last_error = str(e)
        finally:
            # Mark any remaining pending requests as failed
            for fut in self.pending.values():
                if not fut.done():
                    fut.set_exception(RuntimeError("MCP read loop exited"))
            self.pending.clear()


# ─── Global registry — populated from disk on first access ────────────────


_REGISTRY: dict[str, MCPClient] = {}


def get_registry() -> dict[str, MCPClient]:
    if not _REGISTRY:
        cfg = load_config()
        for name, spec in cfg.items():
            _REGISTRY[name] = MCPClient(
                name=name,
                command=spec.get("command", ""),
                args=spec.get("args", []) or [],
                env=spec.get("env", {}) or {},
                enabled=spec.get("enabled", True),
            )
    return _REGISTRY


def upsert(name: str, command: str, args: list, env: dict, enabled: bool) -> MCPClient:
    cfg = load_config()
    cfg[name] = {
        "command": command,
        "args": args,
        "env": env,
        "enabled": enabled,
    }
    save_config(cfg)
    # Replace in registry — terminate old subprocess if running
    old = _REGISTRY.get(name)
    if old and old.is_running:
        # Schedule stop without blocking caller
        asyncio.create_task(old.stop())
    _REGISTRY[name] = MCPClient(
        name=name, command=command, args=args, env=env, enabled=enabled
    )
    return _REGISTRY[name]


def remove(name: str) -> bool:
    cfg = load_config()
    if name not in cfg:
        return False
    del cfg[name]
    save_config(cfg)
    client = _REGISTRY.pop(name, None)
    if client and client.is_running:
        asyncio.create_task(client.stop())
    return True


async def all_external_tools(prefix_with_server: bool = True) -> list[dict]:
    """Return OpenAI-style tool schemas for every enabled, healthy MCP client.

    Schemas are translated from MCP's {name, description, inputSchema} to the
    OpenAI/Ollama function-calling shape, with names prefixed `mcp__<server>__`
    to disambiguate.
    """
    out: list[dict] = []
    for client in get_registry().values():
        if not client.enabled:
            continue
        try:
            if not client.is_running:
                await client.start()
        except Exception as e:
            client.last_error = str(e)
            continue
        for t in client.tools:
            name = t.get("name") or ""
            if not name:
                continue
            full_name = f"mcp__{client.name}__{name}" if prefix_with_server else name
            out.append(
                {
                    "type": "function",
                    "function": {
                        "name": full_name,
                        "description": t.get("description", ""),
                        "parameters": t.get("inputSchema") or {"type": "object"},
                    },
                }
            )
    return out


async def dispatch_external(full_name: str, args: dict) -> dict:
    """Route an `mcp__<server>__<tool>` tool call to the right MCPClient."""
    if not full_name.startswith("mcp__"):
        return {"error": f"not an MCP-prefixed tool: {full_name!r}"}
    rest = full_name[len("mcp__"):]
    if "__" not in rest:
        return {"error": f"malformed MCP tool name: {full_name!r}"}
    server_name, tool_name = rest.split("__", 1)
    client = get_registry().get(server_name)
    if not client:
        return {"error": f"unknown MCP server: {server_name!r}"}
    if not client.enabled:
        return {"error": f"MCP server {server_name!r} is disabled"}
    try:
        result = await client.call_tool(tool_name, args)
        # MCP returns content blocks; flatten to text for the model
        content = result.get("content", []) or []
        text_parts = []
        for c in content:
            if c.get("type") == "text":
                text_parts.append(c.get("text", ""))
        if text_parts:
            return {"text": "\n".join(text_parts), "raw": result}
        return result
    except Exception as e:
        return {"error": str(e)}


async def shutdown_all() -> None:
    for client in _REGISTRY.values():
        if client.is_running:
            await client.stop()


async def status_snapshot() -> list[dict]:
    out = []
    for client in get_registry().values():
        out.append(
            {
                "name": client.name,
                "command": client.command,
                "args": client.args,
                "enabled": client.enabled,
                "is_running": client.is_running,
                "last_error": client.last_error,
                "tools": [t.get("name") for t in client.tools],
                "resources": [r.get("uri") for r in client.resources],
                "tool_count": len(client.tools),
            }
        )
    return out

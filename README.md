# ollama-mempalace

Local chat UI that wires any Ollama model to a [MemPalace](https://github.com/MemPalace/mempalace) memory layer. Recall before send, save after response. Per-wing scoping, rename, delete.

## Setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
# Make sure Ollama is running (the desktop app or `ollama serve`)
python app.py
```

Open http://localhost:8765.

## What it does

- Lists models from `localhost:11434/api/tags` (any model you've `ollama pull`ed)
- Before each send, runs `mempalace.searcher.search_memories` scoped to the current **wing**
- Injects the top-N memory hits as a system message
- Streams the response from Ollama back into the UI
- After response completes, saves the `User: ... / Assistant: ...` exchange as a drawer in the current wing/room
- Sidebar shows which memories were retrieved (transparency)

## Wings

Wings are MemPalace's top-level containers. They're just metadata strings on drawers — nothing special. The UI lets you:

- **+ wing** — pick a name; it materializes when you save your first exchange
- **rename** — rewrites every drawer's `wing` metadata in place
- **delete** — removes every drawer in the wing (irreversible)

Default wing: `personal`. Default room: `general`.

## Env vars

- `OLLAMA_HOST` — defaults to `http://localhost:11434`
- `MEMPALACE_PALACE_PATH` — defaults to `~/.mempalace/palace`

## Notes

- First search downloads a sentence-transformer embedding model (~80MB). Search will be slow the first time.
- The Ollama desktop app and CLI both use the same `ollama serve` daemon, so this UI works alongside them.

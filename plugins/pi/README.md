# Neuralwatt MCR Extension for Pi

A drop-in extension for [Pi](https://pi.dev) that unlocks Neuralwatt's MCR (Managed Context Runtime) long-context models. Get **1M virtual context** through transparent server-side compaction, with on-demand recall of dropped messages via the `mcr_lookup` tool.

The extension works with Neuralwatt's Tier 2 response-header protocol — no Pi core changes, no proxy, no patched build required.

## What it does

When you select a Neuralwatt MCR model (e.g., `neuralwatt/kimi-k2.6-long`, `neuralwatt/glm-5.1-long`), the extension:

- **Context drop** — Reads `X-MCR-Safe-Drop-Before` from response headers and trims old messages the server has already stored, keeping the client bounded while the server maintains a 1M+ virtual context window.
- **Session fingerprint** — Sends `X-MCR-Session-FP` on subsequent requests so the server can resume the same compacted session directly across turns and auto-compact boundaries.
- **Compaction suppression** — Cancels Pi's built-in compaction when MCR is active (the server handles it).
- **Anchor protection** — Preserves the first 3 user messages (MCR's fingerprint anchors) so sessions stay stable.
- **Energy + MCR status bar** — Adds `nw-mcr` (session fingerprint + current drop threshold) and `nw-energy` (cumulative energy + APC cache hit rate + compaction ratio) to Pi's footer.

## Requirements

- Pi v0.72+
- A Neuralwatt API key — get one at [portal.neuralwatt.com](https://portal.neuralwatt.com)

## Install

### 1. Set your API key

```bash
export NEURALWATT_API_KEY=<your-key>
```

Add this to `~/.bashrc` or `~/.zshrc` so it persists across shells.

### 2. Clone this repo

```bash
git clone https://github.com/neuralwatt/neuralwatt-tools.git
```

### 3. Copy the models config

Pi needs to know about Neuralwatt's models. Copy the bundled `models.json` to Pi's config directory:

```bash
cp neuralwatt-tools/plugins/pi/configs/models.json ~/.pi/agent/models.json
```

If you already have a `~/.pi/agent/models.json` with other providers, merge the `neuralwatt` provider entry into your existing file instead of overwriting.

### 4. Copy the extension

Pi auto-discovers extensions under `~/.pi/agent/extensions/`:

```bash
mkdir -p ~/.pi/agent/extensions
cp neuralwatt-tools/plugins/pi/extensions/neuralwatt-mcr.ts ~/.pi/agent/extensions/
```

### 5. Launch Pi and pick a model

```bash
pi
```

Open the model picker with `/model` (or `Ctrl+L`) and pick one of the MCR long-context entries:

- `neuralwatt/kimi-k2.6-long` — Kimi K2.6 with 1M virtual context
- `neuralwatt/glm-5.1-long` — GLM 5.1 with 1M virtual context

Standard non-MCR models (e.g., `glm-5-fast`, `kimi-k2.6-fast`) are also listed in `models.json` and work as normal Neuralwatt models — the extension only activates for MCR-capable models.

## Status bar

When you're on an MCR model, two indicators appear in Pi's footer:

| Key | Shows |
|-----|-------|
| `nw-mcr` | Session fingerprint (first 8 chars) + current drop threshold |
| `nw-energy` | Cumulative energy (mJ/J/kJ), APC cache hit rate, compaction ratio |

Example:

```
MCR a1b2c3d4 | drop<35    nw-energy 2.3J | APC 85% | compact 42%
```

## How context drop works

```
Before: [anchor1, anchor2, anchor3, old_msg_4, ..., old_msg_35, recent_36, ..., recent_85]
After:  [anchor1, anchor2, anchor3, recent_36, ..., recent_85]
                                    dropped [4..35) — server has them stored
```

1. Pi sends a request to the Neuralwatt API.
2. The MCR pipeline compacts old context server-side.
3. Response headers include `X-MCR-Safe-Drop-Before: 35`.
4. On the next `context` event (before the next LLM call), the extension drops messages 4–35.
5. If the model needs anything from a dropped range, it can call the `mcr_lookup` tool and the server retrieves it from its store.

## MCR vs non-MCR models

The extension only activates for MCR-capable models. These are detected by model ID:

- IDs with the `neuralwatt/` prefix (e.g., `neuralwatt/glm-5.1-long`)
- IDs ending in `-long` (indicates a 1M virtual context window)
- Base model IDs starting with `zai-org/`, `moonshotai/`, `glm-5`, `kimi-k2`

For non-MCR models the extension stays out of the way — Pi behaves exactly as it does without the extension installed.

## Known caveats

- **`nw-energy` status bar may show `--` during streaming.** Energy data is currently only emitted on the non-streaming response path; the streaming SSE body does not yet include it. The `nw-mcr` indicator works on both paths. This is tracked and expected to be addressed in a future Neuralwatt API update.
- **If a session ever looks stuck** (no responses, repeated drop events, garbled state), exit Pi and start a fresh session — the server-side MCR state resets per conversation ID.
- **Token cost shows $0.00.** Intentional. All Neuralwatt models bill by energy, not tokens, so the `cost` fields in `models.json` are zeroed. Use the `nw-energy` status bar (and `nw-usage` CLI in this repo) for actual usage tracking.

## Troubleshooting

- **Extension not loading** — Check that the file is at `~/.pi/agent/extensions/neuralwatt-mcr.ts` and Pi's startup output for parse errors.
- **No MCR headers in responses** — Only MCR-backed models (the `-long` variants) return MCR headers. Standard models like `glm-5-fast` don't use MCR.
- **API key not picked up** — `NEURALWATT_API_KEY` must be exported in the shell where you launch `pi`. The models config references the env var by name, so the value is resolved at Pi startup.

## Architecture

```
Pi extension (neuralwatt-mcr.ts)
  |
  +- after_provider_response   reads X-MCR-* headers
  +- message_end               reads response body mcr/energy (fallback)
  +- context                   drops messages per safe_drop_before
  +- before_provider_request   sends X-MCR-Session-FP header
  +- session_before_compact    cancels Pi compaction when MCR active
  +- session_start             resets state
  +- session_shutdown          clears status bar
```

## Feedback

Found a bug or want to suggest an improvement? Open an issue on this repo or drop into the [Neuralwatt Discord](https://discord.gg/ZJEfU2BZw2).

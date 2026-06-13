# Neuralwatt MCR Extension for Pi

A drop-in extension for [Pi](https://pi.dev) that unlocks Neuralwatt's MCR (Managed Context Runtime) long-context models. Get **1M virtual context** through transparent server-side compaction, with on-demand recall of dropped messages via the `mcr_lookup` tool.

The extension works with Neuralwatt's Tier 2 response-header protocol — no Pi core changes, no proxy, no patched build required.

> 🚧 **Private beta.** The MCR long-context aliases (`neuralwatt/kimi-k2.6-long`, `neuralwatt/glm-5.1-long`) are currently in a closed beta. You'll need an access grant on top of a Neuralwatt API key — email **chad@neuralwatt.com** to request one. Once granted, the install steps below work as written; without a grant, calls to the aliases will return 404.

## What it does

When you select a Neuralwatt MCR model (e.g., `neuralwatt/kimi-k2.6-long`, `neuralwatt/glm-5.1-long`), the extension:

- **Context drop** — Reads `X-MCR-Safe-Drop-Before` from response headers and trims old messages the server has already stored, keeping the client bounded while the server maintains a 1M+ virtual context window.
- **Session fingerprint** — Sends `X-MCR-Session-FP` on subsequent requests so the server can resume the same compacted session directly across turns and auto-compact boundaries.
- **Compaction suppression** — Cancels Pi's built-in compaction when MCR is active (the server handles it).
- **Anchor protection** — In the content-anchor fallback (no conversation id on the wire), preserves the first 3 user messages, which the server fingerprints for session identity. When a conversation id IS sent (the normal case — this extension always wires `X-NW-Conversation-ID`), the server keys identity on the conversation id instead, so the anchor floor is unnecessary and the drop honors `safe_drop_before` directly. This lets single-prompt agentic sessions (1 user message + many tool turns) drop normally instead of resending the whole history every turn (2.5.2).
- **Energy + MCR status bar** — Adds `nw-mcr` (session fingerprint + current drop threshold) and `nw-energy` (cumulative energy + APC cache hit rate + compaction ratio) to Pi's footer.
- **Version reporting** — Sends the extension version on every request as the `X-NW-MCR-Ext-Version` header so the gateway can log which client revision served a request (handy when triaging a report — server logs previously had no way to tell a user's extension version).

## Requirements

- Pi v0.72+
- A Neuralwatt API key — get one at [portal.neuralwatt.com](https://portal.neuralwatt.com)

## Install

### 1. Set your API key

```bash
export NEURALWATT_API_KEY=<your-key>
```

Add this to `~/.bashrc` or `~/.zshrc` so it persists across shells.

### 2. Install the extension

Use Pi's built-in package manager — it fetches the extension and adds it to your
settings:

```bash
pi install npm:@neuralwatt/pi-mcr-extension
```

That's the whole install. The model list ships **inside** the extension (it
declares the `neuralwatt` provider and all its models on load), so there's no
separate `models.json` to copy or merge. To install only for the current
project instead of globally, add `-l`:

```bash
pi install npm:@neuralwatt/pi-mcr-extension -l
```

> ⚠️ **An existing `neuralwatt` provider can shadow this one.** If you've
> previously added a Neuralwatt provider to Pi (via `pi /provider`, a hand-edited
> `~/.pi/agent/models.json`, or another extension), it can take precedence and
> the long-context aliases below may not appear in `/model` or may not route
> correctly. Check `pi /provider` and `~/.pi/agent/models.json` for an existing
> `neuralwatt` entry and remove it so the list this extension registers is what
> Pi sees.

### 3. Launch Pi and pick a model

```bash
pi
```

Open the model picker with `/model` (or `Ctrl+L`) and pick one of the MCR long-context entries:

- `neuralwatt/kimi-k2.6-long` — Kimi K2.6 with 1M virtual context
- `neuralwatt/glm-5.1-long` — GLM 5.1 with 1M virtual context

Standard non-MCR models (e.g., `glm-5-fast`, `kimi-k2.6-fast`) are registered by the extension too and work as normal Neuralwatt models — the MCR behaviour only activates for MCR-capable models.

## Updating

The extension is a Pi package, so updating is one command — no re-clone, no file
copy:

```bash
pi update                                  # update pi + all installed packages
pi update npm:@neuralwatt/pi-mcr-extension # update just this extension
```

`pi list` shows what's installed; `pi remove npm:@neuralwatt/pi-mcr-extension`
uninstalls it.

## Status bar

When you're on an MCR model, two indicators appear in Pi's footer:

| Key | Shows |
|-----|-------|
| `nw-mcr` | Session fingerprint (first 8 chars) + current drop threshold. If a request runs unusually long (more than a few seconds), it switches to a neutral `working… 12s` so a long wait doesn't look like a hung model. |
| `nw-energy` | Cumulative energy (mJ/J/kJ), APC cache hit rate, compaction ratio |

Example (idle, or during a normal request):

```
MCR a1b2c3d4 | drop<35    nw-energy 2.3J | APC 85% | compact 42%
```

Example (request still running after several seconds):

```
MCR a1b2c3d4 | working… 12s
```

### Why "working…" and not "optimizing context…"

Earlier versions showed `optimizing context… Ns` for the **entire** time between
sending a request and the first model token, on **every** MCR request. Because
MCR prompts are large (100k+ tokens), that prefill window is naturally 10–60s —
so users saw "optimizing context" on nearly every prompt, for the whole wait,
even though actual context compaction happens on only a small fraction of turns.
That made MCR feel like it was making every prompt slow, which it wasn't.

The honest fix:

- **Normal turns are silent.** Nothing changes in the chip for the first few
  seconds — the passive `MCR <fp> | drop<N>` status stays put.
- **Long waits get a neutral label.** Only after a grace window does the chip
  surface `working… Ns` — a truthful "a request is in flight" signal that does
  **not** claim MCR is doing optimization work.
- **The chip only appears on MCR-backed aliases** (`neuralwatt/…` and `…-long`),
  never on `glm-5.1-fast`/`-flex`, `kimi-k2.6-*`, or direct base-model calls.

The counter advances every ~0.5s until the model starts streaming, at which
point the chip reverts to the standard view.

> **Why not show the real compaction phase?** The gateway already emits the
> ground truth — `event: mcr-status` SSE frames with `compacting` / `warming` /
> `idle` phases ([`inference_frontend#3916`](https://github.com/neuralwatt/inference_frontend/issues/3916)).
> A Pi extension on the current Pi versions (v0.72/0.73) **cannot observe those
> frames**: the only streaming hook (`message_update`) delivers a closed
> `AssistantMessageEvent` union (text/thinking/toolcall only), there is no raw
> SSE-event hook on the extension API, and the OpenAI-compatible stream is
> consumed through the official `openai` SDK, which drops any non-chat-completion
> SSE frame before the extension could see it. So the extension genuinely can't
> tell prefill from compaction — the only honest indicator is a neutral
> in-flight one. A phase-accurate chip is blocked on an upstream Pi capability
> (a hook that surfaces raw provider SSE events). See
> [`neuralwatt/inference_frontend#3954`](https://github.com/neuralwatt/inference_frontend/issues/3954)
> and [tools#33](https://github.com/neuralwatt/neuralwatt-tools/issues/33).

### Verifying the chip behaviour

There's no automated TUI harness, so verify by hand after a `pi update` (or a
fresh `pi install`):

1. **Normal fast turn** — on `neuralwatt/glm-5.1-long`, send a short prompt that
   responds within a few seconds. The chip should stay on `MCR <fp> | drop<N>`
   the whole time; **no** `working…` / `optimizing context…` should ever appear.
2. **Long turn** — send a large prompt (or one that takes >6s to first token).
   After the grace window the chip should switch to `MCR <fp> | working… Ns`
   with the counter advancing, then revert to the standard view the instant the
   model starts streaming.
3. **Non-MCR model** — switch to `glm-5.1-fast` / `glm-5.1-flex` / direct
   `zai-org/GLM-5.1-FP8` and send any prompt, including the first message. The
   `nw-mcr` chip should be empty and stay empty — no `working…`, no MCR
   fingerprint. (Regression check for [tools#33](https://github.com/neuralwatt/neuralwatt-tools/issues/33).)

The extension logs each session start with its version and the in-flight
transitions to `~/.pi/agent/extensions/neuralwatt-mcr.log` — tail it to confirm
which revision is loaded. The same version is also sent on the wire as the
`X-NW-MCR-Ext-Version` request header, so the gateway logs it server-side for
debugging too.

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
5. If the model needs anything from a dropped range, it can call the `mcr_lookup` tool and the server retrieves it from its store. On mixed agentic turns the gateway forwards that tool call to the client by design, so the extension (2.5.0) registers a local `mcr_lookup` stub that returns a short placeholder — the gateway replaces it with the real recalled content on the next request ("cross-turn injection", inference_frontend#4039). The stub never resolves anything itself; without it, pi rendered a harmless-but-alarming "Tool mcr_lookup not found" error in the transcript.

## MCR vs non-MCR models

The extension only activates for MCR-backed aliases. These are detected by model ID:

- IDs with the `neuralwatt/` prefix (e.g., `neuralwatt/glm-5.1-long`)
- IDs ending in `-long` (indicates a 1M virtual context window)

Everything else — `glm-5.1-fast`, `glm-5.1-flex`, `kimi-k2.6-fast`/`-flex`, and
direct base-model IDs like `zai-org/GLM-5.1-FP8` or `moonshotai/...` — is **not**
MCR-backed (no server-side compaction), so the extension stays fully out of the
way: no context drop, no MCR/`working…` chip, no fingerprint handling. Pi behaves
exactly as it does without the extension installed. (Earlier versions matched
those base-model/fast/flex IDs too and wrongly lit the chip on them — see
[tools#33](https://github.com/neuralwatt/neuralwatt-tools/issues/33).)

## Known caveats

- **`nw-energy` status bar may show `--` during streaming.** Energy data is currently only emitted on the non-streaming response path; the streaming SSE body does not yet include it. The `nw-mcr` indicator works on both paths. This is tracked and expected to be addressed in a future Neuralwatt API update.
- **If a session ever looks stuck** (no responses, repeated drop events, garbled state), exit Pi and start a fresh session — the server-side MCR state resets per conversation ID.
- **Token cost shows $0.00.** Intentional. All Neuralwatt models bill by energy, not tokens, so the `cost` fields in the extension's model definitions are zeroed. Use the `nw-energy` status bar (and `nw-usage` CLI in this repo) for actual usage tracking.

## Troubleshooting

- **Extension not loading** — Confirm it's installed with `pi list`, and check Pi's startup output for parse errors. Reinstall with `pi install npm:@neuralwatt/pi-mcr-extension` if needed.
- **Models don't appear in `/model`** — The extension registers the `neuralwatt` provider and its models on load. If the aliases are missing, a pre-existing `neuralwatt` entry in `~/.pi/agent/models.json` is likely shadowing them — see the heads-up under [Install](#install).
- **No MCR headers in responses** — Only MCR-backed models (the `-long` variants) return MCR headers. Standard models like `glm-5-fast` don't use MCR.
- **API key not picked up** — `NEURALWATT_API_KEY` must be exported in the shell where you launch `pi`. The provider config references the env var by name, so the value is resolved at Pi startup.

## Architecture

```
Pi extension (neuralwatt-mcr.ts)
  |
  +- after_provider_response   reads X-MCR-* headers
  +- message_update            clears in-flight chip on first model delta
  +- message_end               reads response body mcr/energy (fallback);
                                 backstop for clearing in-flight chip
  +- context                   drops messages per safe_drop_before
  +- before_provider_request   sends X-MCR-Session-FP header;
                                 starts neutral in-flight chip (silent until
                                 a long wait — never claims "optimizing")
  +- session_before_compact    cancels Pi compaction when MCR active
  +- session_start             resets state (incl. in-flight chip); pins the
                                 bare session id as the gateway conv id
  +- session_tree              pins the new branch's leaf id into the conv
                                 id (sessionId:leafId) so each in-session
                                 branch gets its own gateway session_fp
                                 (v2.3.0+ — see inference_frontend#4111 for
                                 the bug class this addresses)
  +- session_shutdown          clears status bar (incl. in-flight ticker)
```

## Feedback

Found a bug or want to suggest an improvement? Open an issue on this repo or drop into the [Neuralwatt Discord](https://discord.gg/ZJEfU2BZw2).

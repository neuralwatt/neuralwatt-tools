# MCR Context Drop Protocol — Client Integration Guide

**Version**: 2.0
**Date**: 2026-06-03
**Status**: Active
**Audience**: Developers building a client (AI coding agent, chat UI, or any OpenAI-/Anthropic-compatible client) against Neuralwatt MCR models.

> **Changes in 2.0 (breaking — read this if you implemented 1.x):**
> - **Session identity is now carried by a client-generated `X-NW-Conversation-ID` request header.** The 1.x guidance to *echo the server's `X-MCR-Session-FP` back on requests* was never read by the server and is removed. See [Session identity](#session-identity).
> - **The Tier-3 inline content tag (`[[NW-MCR-PROTO-V1:…]]`) and its `X-NW-MCR-Inline-Signals` opt-in have been removed.** There is no inline-tag channel anymore. Read the response **headers** instead — they are now emitted on every endpoint and in streaming mode (this was the gap that broke SDK-based streaming clients; it is fixed). See [Channels](#protocol-channels).
> - **New stream frames you must tolerate:** `event: mcr-status` heartbeats during in-flight compaction. Ignore SSE events/fields you don't recognize.
> - **New server-resolved tool:** the model may emit a `mcr_lookup` tool call. The **server** resolves it — your client must not reject or try to execute it. See [The `mcr_lookup` tool](#the-mcr_lookup-tool).
> - Updated model list and informational headers.

---

## Overview

Neuralwatt MCR (Managed Context Runtime) gives a conversation effectively unlimited context by compacting and caching history **server-side**. The client sends history as usual; the server compacts transparently and reconstructs full context on every turn.

The **context-drop protocol** solves the *client-side* resource problem: as a conversation grows, the client's in-memory history, JSON serialization, and upload size grow without bound — even though the server already has everything stored. This protocol lets the server tell the client *"I have your history through turn N; you can drop the old messages locally and I'll reconstruct them."*

Result: client memory and bandwidth stay bounded, the server rebuilds full context from its store, and the user sees no quality loss.

You do **not** have to implement any of this to use MCR (see [Tier 1](#tier-1-zero-integration)). The protocol is a bandwidth/memory optimization for long sessions.

---

## Quick start

A complete, robust client needs exactly two things:

1. **On every request, send a stable `X-NW-Conversation-ID`** you generate once per conversation (a UUID is fine). This is how the server keeps your session identity after you drop messages.
2. **On every response, read three headers** and trim your local history:
   - `X-MCR-Safe-Drop-Before: N` → you may delete local messages `[0 : N)` (counting **user + assistant** messages, 0-indexed).
   - `X-MCR-Stored-Through: M` → the server has persisted through message `M`.
   - `X-MCR-Session-FP: …` → diagnostic session id (for logs; you do **not** echo it back).

Everything else in this document is detail, edge cases, and streaming specifics.

---

## Protocol Channels

MCR metadata is delivered on these channels. **Response headers are the canonical channel — build on them.** They are emitted on every MCR-backed response on both `/v1/chat/completions` and `/v1/messages`, streaming and non-streaming. The others are convenience mirrors.

| Channel | Format | Availability | Use it when |
|---------|--------|--------------|-------------|
| **Response headers** | `X-MCR-*` | **Always** (both endpoints, streaming + non-streaming) | Always. This is the contract. |
| **Response body** | top-level `mcr` object | Anthropic `/v1/messages` non-streaming response, and the final streaming chunk's `mcr` field | You're already parsing the body and want a mirror |
| **SSE comment** | `: mcr-session {json}` line in the stream | Streaming responses | Your SSE parser exposes comment lines (most SDKs silently drop them — don't rely on this alone) |

> **There is no inline content-tag channel.** If you implemented the 1.x `[[NW-MCR-PROTO-V1:…]]` parser, delete it. Read headers.

### Stream frames to tolerate

In streaming mode the body may include frames beyond normal `data:` deltas:

- `: mcr-session {json}` — an SSE **comment** carrying the same fields as the headers.
- `event: mcr-status` — periodic **heartbeats** emitted while the server is doing in-flight compaction / cache pre-warm for this turn. They carry progress info and are safe to ignore.

**Rule:** ignore any SSE `event:` type or JSON field you don't recognize. Do not error on unknown frames.

---

## Integration Tiers

### Tier 1: Zero integration

Do nothing. Send full conversation history every turn; MCR compacts server-side transparently. Your client behaves exactly as with any OpenAI-/Anthropic-compatible API.

**Tradeoff:** client memory and upload size grow linearly with conversation length. Fine under ~100K tokens; becomes the bottleneck on very long sessions.

### Tier 2: Header-based context drop (recommended)

Send `X-NW-Conversation-ID`, read three response headers, trim your local array. ~20 lines in any language. This is the whole protocol. The rest of this section is the detail.

---

## Tier 2 in detail

### Request headers

| Header | Required | Meaning |
|--------|----------|---------|
| `X-NW-Conversation-ID` | Recommended | A stable, client-generated identifier for this conversation (e.g. a UUID created at conversation start and reused for every turn). Lets the server look up your session directly, so you can drop early messages without losing identity. |
| `X-NW-MCR-Ext-Version` | Optional | Free-form version string for your client/extension (e.g. `my-client/1.4.2`). Telemetry only; sanitized server-side; never affects behavior. Helps us bucket metrics by client version. |

### Response headers

Every MCR-backed response carries these, **on both streaming and non-streaming responses**:

```
X-MCR-Session-FP:        a1b2c3d4e5f6a1b2c3d4e5f6
X-MCR-Stored-Through:    42
X-MCR-Safe-Drop-Before:  30
```

| Header | Type | Meaning |
|--------|------|---------|
| `X-MCR-Session-FP` | string | Server-computed 24-char session fingerprint. Stable across turns. **Diagnostic only** — log it; do not send it back. |
| `X-MCR-Stored-Through` | integer | The server has stored all messages through this index (0-based, counting **user + assistant** messages). Monotonic — never decreases for a session. |
| `X-MCR-Safe-Drop-Before` | integer | You may safely delete local messages before this index. The server reconstructs them from its store. `0` means *nothing is safe to drop yet*. Monotonic — never decreases for a session. |

The following informational headers may also appear. They're useful for debugging/observability; a client can ignore them all:

`X-MCR-Refs-Recovered`, `X-MCR-Refs-Skipped-Budget`, `X-MCR-Refs-Skipped-Missing`, `X-MCR-Recovery-Tokens-Added`, `X-MCR-Refs-In-Forward`, `X-MCR-Manifest-Entries`.

### Session identity

The server identifies a session in one of two ways:

1. **Client scheme (recommended).** If you send `X-NW-Conversation-ID`, the server keys the session on it. You can drop *any* early messages and identity is preserved.
2. **Content-anchor fallback.** If you send no conversation id, the server fingerprints the **first 3 user messages**. This still works across drops **only if you never drop those first 3 user messages** (and the assistant turns between them).

> Sending `X-NW-Conversation-ID` is strictly more robust — it removes the "must preserve the first 3 user messages" constraint. New clients should always send it.

The old 1.x advice — "read `X-MCR-Session-FP` from the response and send it back on the next request" — **does nothing**; the server does not read that header on requests. Use `X-NW-Conversation-ID`.

### Client algorithm

```
# once per conversation:
conversation_id = uuid4()

on_request(messages):
    return api_call(messages, extra_headers={
        "X-NW-Conversation-ID": conversation_id,
    })

on_response(response, local_messages):
    safe_drop = int(response.headers.get("X-MCR-Safe-Drop-Before", 0))
    if safe_drop <= 0:
        return  # nothing to drop yet

    # Safety net: never drop the first 3 user messages (content-anchor zone).
    # With X-NW-Conversation-ID set this is belt-and-suspenders, but cheap.
    anchor_floor = index_of_nth_user_message(local_messages, 3)
    drop_start = anchor_floor + 1
    drop_end   = safe_drop
    if drop_end <= drop_start:
        return

    # Remove user/assistant messages whose 0-based u+a index is in [drop_start, drop_end).
    del_user_assistant_in_range(local_messages, drop_start, drop_end)
```

### Message indexing

`X-MCR-Stored-Through` and `X-MCR-Safe-Drop-Before` count **only `role: "user"` and `role: "assistant"` messages**, 0-indexed. System messages, tool calls, and tool results are **not** counted. When mapping an index back to your array, walk the array counting only user/assistant entries:

```
u/a index 0: first user message
u/a index 1: first assistant message
u/a index 2: second user message
...
```

### Anchor protection

Keep the **first 3 user messages** (and assistant turns between them). The server's `safe_drop_before` already respects this, but enforce it locally as a safety net — dropping the anchor zone while relying on the content-anchor fallback would orphan the cached session. (With `X-NW-Conversation-ID` set, identity no longer depends on the anchors, but keeping the guard costs nothing.)

The anchor count is **3**. If it ever changes, it will be announced in a future protocol version.

### Idempotency & the monotonic guarantee

Applying the same `safe_drop_before` twice is safe — the second time the range is already empty. You don't need to track which drops you've applied.

`safe_drop_before` and `stored_through` are **monotonic high-water marks per session**: they never move backward, even when you honor a drop and send a shorter array on the next turn. (Earlier server versions could oscillate here; that's fixed.) So a client that simply trims to `safe_drop_before` each turn will never be told to "un-drop."

### `safe_drop_before == 0`

Means *don't drop anything*. It's the normal state for short sessions: MCR compacts lazily and only starts advising drops once the conversation approaches the backend model's context limit. Below that threshold you'll see `0` every turn — keep full history; this is expected.

---

## The `mcr_lookup` tool

On MCR models the server may register and use an internal tool named **`mcr_lookup`**. When the model needs content that MCR compacted away, it calls `mcr_lookup` and **the server intercepts and resolves the call itself** — the resolved content is folded back into the conversation server-side.

**What your client must do:** nothing, except *not get in the way*:

- **Do not reject or error on a tool named `mcr_lookup`.** If your client validates/filters the tool list, allow it through.
- **Do not try to execute `mcr_lookup` yourself.** It has no client-side implementation; the server handles it. If your agent loop blindly executes every tool call, you'll produce a `Tool mcr_lookup not found` result and stall the model. Either let the server resolve it (the default) or pass the tool call through untouched.
- **Preserve `tool_call_id`s verbatim** across the round-trip. The server matches the tool call to its resolution by id; if your client regenerates or normalizes ids, server-side resolution can miss.

If you don't manage tools at all (you just forward the server's response), there is nothing to do.

---

## Response body & metrics (informational)

The same drop fields are mirrored in the response body where available — on the Anthropic `/v1/messages` non-streaming response and on the final streaming chunk:

```json
{
  "choices": [...],
  "usage": {...},
  "mcr": {
    "session_fp": "a1b2c3d4e5f6a1b2c3d4e5f6",
    "stored_through": 42,
    "safe_drop_before": 30
  }
}
```

Additional MCR metrics are reported under `energy.mcr` (compaction flags, session turns, context tokens, etc.). These are for dashboards/debugging and are **not** part of the drop protocol — field set may evolve.

> **Headers are the only channel guaranteed on every endpoint and mode. Build on headers; treat the body `mcr` object as a convenience mirror.**

---

## Model compatibility

The protocol applies to MCR-backed (`virtual_context`) models. Current ones (access is grant-gated during the private beta):

| Model ID | Backend context | Virtual context |
|----------|-----------------|-----------------|
| `neuralwatt/glm-5.1-long` | ~198K | Effectively unbounded |
| `neuralwatt/kimi-k2.6-long` | 256K | Effectively unbounded |
| `neuralwatt/glm-5.1-fast-long` | ~198K | Effectively unbounded |
| `neuralwatt/kimi-k2.6-fast-long` | 256K | Effectively unbounded |

Non-MCR models (e.g. `glm-5.1-fast`, `kimi-k2.6`) return **no** MCR headers or metadata — handle their absence gracefully (treat missing `X-MCR-Safe-Drop-Before` as `0`).

---

## Migration from 1.x

| 1.x | 2.0 |
|-----|-----|
| Echo `X-MCR-Session-FP` on requests | **Stop.** It was never read. Send a client-generated `X-NW-Conversation-ID` instead. |
| Tier 3 inline `[[NW-MCR-PROTO-V1:…]]` tag + `X-NW-MCR-Inline-Signals: 1` opt-in | **Removed.** Delete the tag parser and the opt-in header. Read response headers. |
| Streaming clients fell back to SSE comments because headers were missing | Headers are now emitted on streaming responses too. Read them off the HTTP response; SSE comments are optional. |
| `<!-- mcr: {…} -->` HTML comment (pre-1.1) | Long removed. |
| Models `kimi-k2.5-long`, `glm-5.1-fast-long` | See [current model list](#model-compatibility). |

---

## FAQ

**Q: What if my client implements none of this?**
A: It still works. MCR compacts server-side; you just send full history and pay growing client-side memory/upload cost.

**Q: Can I drop more aggressively than `safe_drop_before`?**
A: No. The server only guarantees reconstruction for messages at or after what it has stored. Dropping past `safe_drop_before` risks losing context the server hasn't cached yet.

**Q: A turn failed / the network dropped. Do I need recovery logic?**
A: No. Session state is persisted server-side. On the next successful request (same `X-NW-Conversation-ID`) you'll get fresh, monotonic drop pointers and continue from there.

**Q: Should I disable my client's own compaction?**
A: Recommended. If both MCR and client-side compaction run, your client may summarize messages MCR has already stored verbatim, degrading retrieval. Set your client's auto-compaction off on MCR models.

**Q: My agent executes tool calls in a loop and I got `Tool mcr_lookup not found`.**
A: That's the model calling the server-side `mcr_lookup` tool and your loop trying to run it locally. Don't — let the server resolve it, allow the tool name through your filter, and preserve `tool_call_id`s. See [The `mcr_lookup` tool](#the-mcr_lookup-tool).

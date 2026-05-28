import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

const MCR_ANCHOR_USER_MESSAGES = 3;

const LOG_FILE = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "extensions",
  "neuralwatt-mcr.log",
);

function nwlog(event: string, data: Record<string, unknown> = {}): void {
  try {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + "\n";
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // never break the extension on logging failure
  }
}

interface MCRMetadata {
  session_fp: string;
  stored_through: number;
  safe_drop_before: number;
}

interface EnergyData {
  energy_joules: number;
  mcr?: {
    session_turns: number;
    context_tokens: number;
    compaction_triggered: boolean;
    apc_hit_rate?: number;
    mcr_compacted_tokens?: number;
    mcr_original_tokens?: number;
  };
}

interface SessionState {
  sessionFp: string | null;
  safeDropBefore: number;
  storedThrough: number;
  totalEnergyJoules: number;
  sessionTurns: number;
  contextTokens: number;
  lastMcrMeta: MCRMetadata | null;
  lastEnergy: EnergyData | null;
  // Issue #3914: in-flight request UX. When an MCR request is sent we flip
  // ``inFlightSince`` to the wall-clock send time so the chip can show
  // "optimizing context…" until the response stream produces real model
  // output. Cleared on first ``message_update`` or on ``message_end``.
  inFlightSince: number | null;
  inFlightTickerHandle: NodeJS.Timeout | null;
}

const state: SessionState = {
  sessionFp: null,
  safeDropBefore: 0,
  storedThrough: 0,
  totalEnergyJoules: 0,
  sessionTurns: 0,
  contextTokens: 0,
  lastMcrMeta: null,
  lastEnergy: null,
  inFlightSince: null,
  inFlightTickerHandle: null,
};

// Issue #3914: how often to refresh the chip while the in-flight indicator
// is showing, so the elapsed counter advances visibly. 500ms is fast enough
// to feel live but well below the refresh budget of Pi's footer.
const IN_FLIGHT_TICK_MS = 500;

function isMCRModel(modelId: string): boolean {
  return (
    modelId.includes("neuralwatt/") ||
    modelId.includes("-long") ||
    modelId.startsWith("zai-org/") ||
    modelId.startsWith("moonshotai/") ||
    modelId.startsWith("glm-5") ||
    modelId.startsWith("kimi-k2")
  );
}

function extractMCRFromHeaders(
  headers: Record<string, string>,
): MCRMetadata | null {
  const fp = headers["x-mcr-session-fp"];
  if (!fp) return null;
  return {
    session_fp: fp,
    stored_through: parseInt(headers["x-mcr-stored-through"] || "0", 10),
    safe_drop_before: parseInt(
      headers["x-mcr-safe-drop-before"] || "0",
      10,
    ),
  };
}

// Parse a header value as an integer if present, else null. We keep null
// distinct from 0 because:
//   * absent header  -> gateway did not run the M1.b ref-recovery code path
//     (older deploy, non-MCR request, or path bailed before emitting)
//   * 0              -> ref-recovery ran but had nothing to surface
// This distinction is the whole point of issue #3371 follow-up.
function parseOptionalIntHeader(
  headers: Record<string, string>,
  name: string,
): number | null {
  const raw = headers[name];
  if (raw === undefined || raw === null || raw === "") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function extractMCRFromBody(
  body: Record<string, unknown>,
): MCRMetadata | null {
  const mcr = body.mcr as Record<string, unknown> | undefined;
  if (!mcr || typeof mcr !== "object" || typeof mcr.session_fp !== "string")
    return null;
  return {
    session_fp: mcr.session_fp as string,
    stored_through:
      typeof mcr.stored_through === "number" ? mcr.stored_through : 0,
    safe_drop_before:
      typeof mcr.safe_drop_before === "number" ? mcr.safe_drop_before : 0,
  };
}

function extractEnergyFromBody(
  body: Record<string, unknown>,
): EnergyData | null {
  const energy = body.energy as Record<string, unknown> | undefined;
  if (!energy || typeof energy !== "object") return null;
  const result: EnergyData = {
    energy_joules:
      typeof energy.energy_joules === "number" ? energy.energy_joules : 0,
  };
  if (energy.mcr && typeof energy.mcr === "object") {
    const m = energy.mcr as Record<string, unknown>;
    result.mcr = {
      session_turns:
        typeof m.session_turns === "number" ? m.session_turns : 0,
      context_tokens:
        typeof m.context_tokens === "number" ? m.context_tokens : 0,
      compaction_triggered:
        typeof m.compaction_triggered === "boolean"
          ? m.compaction_triggered
          : false,
      apc_hit_rate:
        typeof m.apc_hit_rate === "number" ? m.apc_hit_rate : undefined,
      mcr_compacted_tokens:
        typeof m.mcr_compacted_tokens === "number"
          ? m.mcr_compacted_tokens
          : undefined,
      mcr_original_tokens:
        typeof m.mcr_original_tokens === "number"
          ? m.mcr_original_tokens
          : undefined,
    };
  }
  return result;
}

function formatEnergy(joules: number): string {
  if (joules < 1) return `${(joules * 1000).toFixed(0)}mJ`;
  if (joules < 1000) return `${joules.toFixed(1)}J`;
  return `${(joules / 1000).toFixed(2)}kJ`;
}

// Issue #3914: render an in-flight elapsed-time stamp for the chip. Short
// formats (<10s → "1.4s", >=10s → "12s", >=60s → "1m 5s") to keep the chip
// from growing wide enough to push other footer widgets off-screen.
function formatElapsed(ms: number): string {
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

// Extract the role/type marker from an entry. Pi's outbound HTTP payload
// uses OpenAI-shape ``role`` (``user``/``assistant``/``tool``/``system``);
// Pi's internal session-log records sometimes serialize the same field as
// ``type``. Read both so this extension works regardless of which shape
// the agent-runtime hands us via the ``context`` hook event.
function entryRole(entry: { role?: string; type?: string }): string | undefined {
  return entry.role ?? entry.type;
}

// Returns the FULL message index of the Nth user message (matching the
// indexing space of the server's `safe_drop_before`, which counts every
// message — user/assistant/tool/system — in send order). The earlier
// version returned a user+assistant-subset index, which mixed index
// spaces with `safe_drop_before` in `computeDropRange` and caused
// `context_drop` to silently nuke the most-recent user prompts when the
// upper bound exceeded the user+assistant subset size.
function findAnchorFloor(
  entries: Array<{ role?: string; type?: string }>,
  nAnchors: number,
): number {
  let userCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const role = entryRole(entries[i]);
    if (role === "user") {
      userCount++;
      if (userCount === nAnchors) return i;
    }
  }
  return -1;
}

// Server-side validation for X-NW-Conversation-ID (mirrors
// services/mcr_v3_session.py::validate_client_conversation_id):
//
//   * non-empty, ≤ 256 chars
//   * all code points printable (no control / whitespace beyond plain space)
//
// We sanitize here so a malformed Pi session id can never bounce off the
// server as HTTP 400 — the worst case is we fall back to the in-process UUID.
const MAX_CONVERSATION_ID_LEN = 256;

function isWellFormedConversationId(value: string): boolean {
  if (!value || value.length === 0 || value.length > MAX_CONVERSATION_ID_LEN) {
    return false;
  }
  // Reject any control character (matches server's `not c.isprintable()` rule).
  // We allow plain ASCII space (0x20) and everything ≥ 0x20 except 0x7F (DEL).
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

// Per-process fallback id. Generated lazily so it stays stable across
// auto-compact within one `pi` invocation, and differs across invocations.
let uuidFallback: string | null = null;
function getUuidFallback(): string {
  if (!uuidFallback) {
    uuidFallback = randomUUID();
  }
  return uuidFallback;
}

type ConversationIdSource = "pi-session" | "uuid-fallback";

function resolveConversationId(
  ctx: ExtensionContext,
): { id: string; source: ConversationIdSource } {
  // Preferred source: Pi's own session id. Stable across auto-compact in a
  // single `pi` session, distinct across sessions, naturally string-form.
  try {
    const piSessionId = ctx.sessionManager?.getSessionId?.();
    if (
      typeof piSessionId === "string" &&
      isWellFormedConversationId(piSessionId)
    ) {
      return { id: piSessionId, source: "pi-session" };
    }
  } catch {
    // fall through to uuid fallback
  }
  return { id: getUuidFallback(), source: "uuid-fallback" };
}

function computeDropRange(
  entries: Array<{ role?: string; type?: string }>,
  safeDropBefore: number,
): [number, number] {
  if (safeDropBefore <= 0) return [0, 0];
  const anchorIdx = findAnchorFloor(entries, MCR_ANCHOR_USER_MESSAGES);
  if (anchorIdx < 0) return [0, 0];
  const dropStart = anchorIdx + 1;
  const dropEnd = safeDropBefore;
  if (dropEnd <= dropStart) return [0, 0];
  return [dropStart, dropEnd];
}

export default function (pi: ExtensionAPI) {
  const MCR_STATUS_KEY = "nw-mcr";
  const ENERGY_STATUS_KEY = "nw-energy";

  // ── X-NW-Conversation-ID header wiring ──────────────────────────────
  // pi-coding-agent's `before_provider_request` is a *body* hook — the
  // earlier `payload.headers[...]` mutation reached extension memory only,
  // never the HTTP wire. The documented per-request header path is
  // `pi.registerProvider({ headers })`, whose values are env-var names that
  // the SDK re-reads from `process.env` on every stream
  // (dist/core/resolve-config-value.js). Net: real HTTP header, no body
  // touch, no APC impact.
  //
  // Boot order: we seed the env var with a UUID at extension load so any
  // request fired before the first `before_provider_request` tick still
  // carries *some* id. The hook upgrades it to Pi's stable per-invocation
  // session id (see resolveConversationId). Subsequent requests in the
  // same `pi` invocation reuse the upgraded value — invocation-stable
  // session_fp by construction.
  const CONV_ID_ENV = "X_NW_CONVERSATION_ID";
  if (!process.env[CONV_ID_ENV]) {
    process.env[CONV_ID_ENV] = getUuidFallback();
  }
  // `apiKey` mirrors the env-var name from ~/.pi/agent/models.json so the
  // partial config doesn't shadow the existing auth. `storeProviderRequestConfig`
  // doesn't merge with the models.json-derived entry (different map), so we
  // have to re-state any field we need; only apiKey here, since baseUrl/api
  // flow through via the override-only branch of applyProviderConfig.
  pi.registerProvider("neuralwatt", {
    apiKey: "NEURALWATT_API_KEY",
    headers: { "X-NW-Conversation-ID": CONV_ID_ENV },
  });

  function updateStatusBar(ctx: ExtensionContext) {
    // Issue #3914: when an MCR request is in flight, show an "optimizing
    // context…" indicator with elapsed time so the user knows the gateway
    // is working (compaction or KV pre-warm) and the model hasn't hung.
    // Dio's first-MCR-tester feedback (2026-05-28) named the exact failure
    // mode this fixes: a silent multi-second pause looking identical to a
    // crashed model. The in-flight indicator takes precedence over the
    // standard "MCR <fp> | drop<N>" chip text — once the response stream
    // produces real model output, ``markStreamProducing`` clears
    // ``inFlightSince`` and the chip reverts to the standard view.
    if (state.inFlightSince !== null) {
      const elapsedMs = Date.now() - state.inFlightSince;
      const fpPrefix = state.sessionFp
        ? `MCR ${state.sessionFp.slice(0, 8)} | `
        : "MCR | ";
      ctx.ui.setStatus(
        MCR_STATUS_KEY,
        `${fpPrefix}optimizing context… ${formatElapsed(elapsedMs)}`,
      );
    } else if (state.sessionFp) {
      const parts: string[] = [`MCR ${state.sessionFp.slice(0, 8)}`];
      if (state.safeDropBefore > 0) {
        parts.push(`drop<${state.safeDropBefore}`);
      }
      ctx.ui.setStatus(MCR_STATUS_KEY, parts.join(" | "));
    } else {
      ctx.ui.setStatus(MCR_STATUS_KEY, "");
    }

    if (state.totalEnergyJoules > 0) {
      const parts: string[] = [`⚡ ${formatEnergy(state.totalEnergyJoules)}`];
      if (state.lastEnergy?.mcr) {
        const m = state.lastEnergy.mcr;
        if (m.apc_hit_rate !== undefined) {
          parts.push(`APC ${(m.apc_hit_rate * 100).toFixed(0)}%`);
        }
        if (m.mcr_compacted_tokens && m.mcr_original_tokens) {
          const ratio = m.mcr_compacted_tokens / m.mcr_original_tokens;
          parts.push(`compact ${(ratio * 100).toFixed(0)}%`);
        }
      }
      ctx.ui.setStatus(ENERGY_STATUS_KEY, parts.join(" | "));
    } else {
      ctx.ui.setStatus(ENERGY_STATUS_KEY, "");
    }
  }

  // Issue #3914: lifecycle helpers for the in-flight indicator. We bracket
  // the wait window with ``markRequestSent`` (on before_provider_request)
  // and ``markStreamProducing`` (on the first message_update / message_end
  // that carries real model output).
  //
  // The chip's elapsed counter advances via a ``setInterval`` that re-calls
  // ``updateStatusBar`` every ~0.5s. Without the ticker the chip would
  // freeze at "0.0s" until the response arrives, defeating the point.
  //
  // Forward-compatible note: the gateway (issue #3914 server side) also
  // emits ``event: mcr-status`` SSE frames carrying {phase: compacting |
  // warming | idle, elapsed_ms}. Pi's extension API does not currently
  // surface raw SSE event types other than the standard message deltas
  // (see types.d.ts::AssistantMessageEvent — only text/thinking/toolcall
  // types reach extensions). When Pi adds an SSE-event hook we can swap
  // the time-based estimate below for the server's authoritative phase
  // signal and distinguish "compacting" from "warming" in the chip text.
  function markRequestSent(ctx: ExtensionContext) {
    state.inFlightSince = Date.now();
    if (state.inFlightTickerHandle !== null) {
      clearInterval(state.inFlightTickerHandle);
    }
    state.inFlightTickerHandle = setInterval(() => {
      // Defensive: stop ticking if the in-flight flag was cleared
      // out-of-band (e.g. session_start reset).
      if (state.inFlightSince === null) {
        if (state.inFlightTickerHandle !== null) {
          clearInterval(state.inFlightTickerHandle);
          state.inFlightTickerHandle = null;
        }
        return;
      }
      updateStatusBar(ctx);
    }, IN_FLIGHT_TICK_MS);
    updateStatusBar(ctx);
  }

  function markStreamProducing(ctx: ExtensionContext) {
    if (state.inFlightSince === null) return;
    state.inFlightSince = null;
    if (state.inFlightTickerHandle !== null) {
      clearInterval(state.inFlightTickerHandle);
      state.inFlightTickerHandle = null;
    }
    updateStatusBar(ctx);
  }

  // Upgrade X_NW_CONVERSATION_ID to Pi's stable session-id as early as
  // possible — `session_start` fires before any provider request and is the
  // earliest hook with ctx. Without this, the first request of each fresh
  // `pi -p` invocation would carry the boot-time UUID (different per
  // process) and produce a cold-cache session_fp that drags APC averages
  // down on `--continue` chains.
  pi.on("session_start", async (_event, ctx) => {
    const { id: conversationId } = resolveConversationId(ctx);
    process.env[CONV_ID_ENV] = conversationId;
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const modelId = ctx.model?.id || "";
    if (!isMCRModel(modelId)) return;

    const headers = event.headers as Record<string, string>;
    const mcrFromHeaders = extractMCRFromHeaders(headers);

    nwlog("after_provider_response", {
      model: modelId,
      header_fp: headers["x-mcr-session-fp"] ?? null,
      header_safe_drop_before: headers["x-mcr-safe-drop-before"] ?? null,
      header_stored_through: headers["x-mcr-stored-through"] ?? null,
      parsed: mcrFromHeaders,
    });

    // M1.b ref-recovery observability (issue #3371 follow-up). The
    // gateway's recent_ref_expansion path runs on the gateway->backend
    // payload, which is invisible to Pi — without these headers in the
    // log we can't tell "ref-recovery ran with no refs available" apart
    // from "ref-recovery never ran". Counts only, no preview/sha values.
    // Server-side emission: API_Gateway/app/services/mcr_anthropic_native_proxy.py::_add_mcr_refs_headers
    const refsRecovered = parseOptionalIntHeader(headers, "x-mcr-refs-recovered");
    const refsInForward = parseOptionalIntHeader(headers, "x-mcr-refs-in-forward");
    const refsSkippedBudget = parseOptionalIntHeader(
      headers,
      "x-mcr-refs-skipped-budget",
    );
    const refsSkippedMissing = parseOptionalIntHeader(
      headers,
      "x-mcr-refs-skipped-missing",
    );
    const recoveryTokensAdded = parseOptionalIntHeader(
      headers,
      "x-mcr-recovery-tokens-added",
    );
    const manifestEntries = parseOptionalIntHeader(
      headers,
      "x-mcr-manifest-entries",
    );

    if (
      refsRecovered !== null ||
      refsInForward !== null ||
      refsSkippedBudget !== null ||
      refsSkippedMissing !== null ||
      recoveryTokensAdded !== null ||
      manifestEntries !== null
    ) {
      nwlog("mcr_refs", {
        refs_recovered: refsRecovered,
        refs_in_forward: refsInForward,
        refs_skipped_budget: refsSkippedBudget,
        refs_skipped_missing: refsSkippedMissing,
        recovery_tokens_added: recoveryTokensAdded,
        manifest_entries: manifestEntries,
      });
    }

    if (mcrFromHeaders) {
      state.sessionFp = mcrFromHeaders.session_fp;
      state.safeDropBefore = mcrFromHeaders.safe_drop_before;
      state.storedThrough = mcrFromHeaders.stored_through;
      state.lastMcrMeta = mcrFromHeaders;
    }

    updateStatusBar(ctx);
  });

  // Issue #3914: clear the in-flight indicator on the first message_update
  // for an MCR model — at that point real model tokens are flowing, the
  // "is it hung?" perception is gone, and the chip should revert to the
  // standard MCR-fingerprint view. The MessageUpdateEvent fires for any
  // assistant streaming update (text/thinking/toolcall deltas); we don't
  // need to narrow further since any of these prove the wait is over.
  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!isMCRModel(ctx.model?.id || "")) return;
    markStreamProducing(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!isMCRModel(ctx.model?.id || "")) return;

    // Issue #3914: backstop — if a response was short enough that no
    // message_update ever fired, message_end is the latest possible
    // chance to clear the indicator before it gets stale.
    markStreamProducing(ctx);

    const msg = event.message as Record<string, unknown>;

    const mcrFromBody = extractMCRFromBody(msg);
    if (mcrFromBody) {
      nwlog("message_end_mcr_body", { parsed: mcrFromBody });
      state.sessionFp = mcrFromBody.session_fp;
      state.safeDropBefore = mcrFromBody.safe_drop_before;
      state.storedThrough = mcrFromBody.stored_through;
      state.lastMcrMeta = mcrFromBody;
    }

    const energy = extractEnergyFromBody(msg);
    if (energy) {
      nwlog("message_end_energy", {
        energy_joules: energy.energy_joules,
        cumulative_joules: state.totalEnergyJoules + energy.energy_joules,
        session_turns: energy.mcr?.session_turns,
        context_tokens: energy.mcr?.context_tokens,
        compaction_triggered: energy.mcr?.compaction_triggered,
        apc_hit_rate: energy.mcr?.apc_hit_rate,
        mcr_compacted_tokens: energy.mcr?.mcr_compacted_tokens,
        mcr_original_tokens: energy.mcr?.mcr_original_tokens,
      });
      state.totalEnergyJoules += energy.energy_joules;
      state.lastEnergy = energy;
      if (energy.mcr) {
        state.sessionTurns = energy.mcr.session_turns;
        state.contextTokens = energy.mcr.context_tokens;
      }
    }

    updateStatusBar(ctx);
  });

  pi.on("context", async (event, ctx) => {
    const modelId = ctx.model?.id || "";
    const numMsgs = event.messages.length;

    if (!state.sessionFp) {
      nwlog("context_skip", {
        reason: "no_session_fp",
        model: modelId,
        num_msgs: numMsgs,
      });
      return;
    }
    if (state.safeDropBefore <= 0) {
      nwlog("context_skip", {
        reason: "safe_drop_before_zero",
        model: modelId,
        num_msgs: numMsgs,
        safe_drop_before: state.safeDropBefore,
        session_fp: state.sessionFp,
      });
      return;
    }
    if (!isMCRModel(modelId)) {
      nwlog("context_skip", {
        reason: "not_mcr_model",
        model: modelId,
        num_msgs: numMsgs,
      });
      return;
    }

    const [dropStart, dropEnd] = computeDropRange(
      event.messages as Array<{ type: string }>,
      state.safeDropBefore,
    );

    if (dropEnd <= dropStart) {
      nwlog("context_no_drop", {
        reason: "empty_range",
        drop_start: dropStart,
        drop_end: dropEnd,
        safe_drop_before: state.safeDropBefore,
        num_msgs: numMsgs,
        session_fp: state.sessionFp,
      });
      return;
    }

    // Drop messages in the full-index range [dropStart, dropEnd). Both
    // bounds are in the same indexing space as `event.messages` and as the
    // server's `safe_drop_before` (every message counted, all roles). The
    // earlier version maintained a separate user+assistant-subset counter
    // and compared it against full-index bounds, which silently nuked the
    // most-recent user prompts (#bug discovered 2026-05-16 — see commit
    // message for the trace).
    const clampedEnd = Math.min(dropEnd, event.messages.length);
    const filtered = event.messages.filter(
      (_: unknown, i: number) => i < dropStart || i >= clampedEnd,
    );
    const droppedCount = numMsgs - filtered.length;

    if (droppedCount === 0) {
      nwlog("context_no_drop", {
        reason: "no_indices_matched",
        drop_start: dropStart,
        drop_end: clampedEnd,
        safe_drop_before: state.safeDropBefore,
        num_msgs: numMsgs,
        session_fp: state.sessionFp,
      });
      return;
    }

    nwlog("context_drop", {
      drop_start: dropStart,
      drop_end: clampedEnd,
      safe_drop_before: state.safeDropBefore,
      num_msgs_before: numMsgs,
      num_msgs_after: filtered.length,
      dropped: droppedCount,
      session_fp: state.sessionFp,
    });

    return { messages: filtered };
  });

  pi.on("before_provider_request", async (event, ctx) => {
    if (!isMCRModel(ctx.model?.id || "")) return;

    const payload = event.payload as Record<string, unknown>;

    // Issue #3914: start the in-flight indicator. The chip shows
    // "optimizing context… 1.4s" with the elapsed counter advancing every
    // ~0.5s until the model starts producing real output (handled in
    // ``message_update``). For MCR-long requests this window can be
    // multiple seconds (compaction + KV pre-warm + TTFT); without the
    // indicator the chat UI is indistinguishable from a hung model.
    markRequestSent(ctx);

    // Upgrade the X_NW_CONVERSATION_ID env var (seeded with a UUID at
    // extension load) to Pi's stable per-invocation session id. The SDK
    // re-reads process.env on every stream, so this propagates to the
    // next outbound request as the real X-NW-Conversation-ID HTTP header
    // — no body touch. See the header-wiring block at the top of this fn
    // and pi-header-surface.md for the full mechanism trace.
    const { id: conversationId, source: conversationIdSource } =
      resolveConversationId(ctx);
    process.env[CONV_ID_ENV] = conversationId;
    nwlog("conversation_id_attached", {
      conversation_id_prefix: conversationId.slice(0, 8),
      source: conversationIdSource,
    });

    // X-MCR-Session-FP fast-path hint: previously set via the same
    // body-only mechanism that never reached the wire. Currently a no-op;
    // diagnostic log retained so we still see when the gateway has
    // assigned an fp. Revisit via registerProvider if we want it back.
    if (state.sessionFp) {
      nwlog("before_provider_request_fp_set", {
        session_fp: state.sessionFp,
        safe_drop_before: state.safeDropBefore,
      });
    }

    // DEBUG (#3323 follow-up): capture the actual outbound payload shape
    // so we can diagnose why the deployed pin-final-user-turn fix isn't
    // firing for real Pi sessions. Logs shape only — no message content.
    try {
      const msgs = (payload.body as { messages?: Array<Record<string, unknown>> } | undefined)?.messages
        ?? (payload.messages as Array<Record<string, unknown>> | undefined)
        ?? [];
      const roles = msgs.map((m) => String(m.role ?? m.type ?? "?"));
      const lastN = msgs.slice(-5).map((m) => {
        const role = String(m.role ?? m.type ?? "?");
        const contentField = m.content;
        let contentKind: string;
        let contentLen: number;
        if (typeof contentField === "string") {
          contentKind = "string";
          contentLen = contentField.length;
        } else if (Array.isArray(contentField)) {
          contentKind = "array[" + contentField.length + "]";
          contentLen = contentField.reduce((acc, b) => acc + JSON.stringify(b).length, 0);
        } else if (contentField === null || contentField === undefined) {
          contentKind = "null";
          contentLen = 0;
        } else {
          contentKind = typeof contentField;
          contentLen = JSON.stringify(contentField).length;
        }
        const blockTypes = Array.isArray(contentField)
          ? (contentField as Array<Record<string, unknown>>).map((b) => String(b.type ?? "?"))
          : null;
        return { role, contentKind, contentLen, blockTypes, hasToolCallId: "tool_call_id" in m };
      });
      const roleCounts: Record<string, number> = {};
      for (const r of roles) roleCounts[r] = (roleCounts[r] || 0) + 1;
      nwlog("outbound_payload_shape", {
        session_fp: state.sessionFp,
        num_messages: msgs.length,
        role_distribution: roleCounts,
        last_5_messages: lastN,
        stream: Boolean((payload.body as { stream?: boolean } | undefined)?.stream ?? payload.stream),
        payload_keys: Object.keys(payload),
      });
    } catch (err) {
      nwlog("outbound_payload_shape_error", {
        session_fp: state.sessionFp,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    if (!isMCRModel(ctx.model?.id || "")) return;
    if (state.sessionFp) {
      nwlog("compaction_cancelled", { session_fp: state.sessionFp });
      return { cancel: true };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    nwlog("session_start", {});
    state.sessionFp = null;
    state.safeDropBefore = 0;
    state.storedThrough = 0;
    state.totalEnergyJoules = 0;
    state.sessionTurns = 0;
    state.contextTokens = 0;
    state.lastMcrMeta = null;
    state.lastEnergy = null;
    // Issue #3914: clear any in-flight indicator left over from a prior
    // session (defensive — session_start would normally fire after any
    // active request has completed, but a forced restart or fork can land
    // here while inFlightSince is still set).
    state.inFlightSince = null;
    if (state.inFlightTickerHandle !== null) {
      clearInterval(state.inFlightTickerHandle);
      state.inFlightTickerHandle = null;
    }
    // Reset the UUID fallback so a new Pi session gets a fresh conversation
    // id when getSessionId() isn't usable. The Pi session id itself rotates
    // on its own.
    uuidFallback = null;
    ctx.ui.setStatus(MCR_STATUS_KEY, "");
    ctx.ui.setStatus(ENERGY_STATUS_KEY, "");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    nwlog("session_shutdown", {
      final_session_fp: state.sessionFp,
      total_energy_joules: state.totalEnergyJoules,
      session_turns: state.sessionTurns,
    });
    // Issue #3914: tear down the in-flight ticker so the interval handle
    // doesn't outlive the session.
    state.inFlightSince = null;
    if (state.inFlightTickerHandle !== null) {
      clearInterval(state.inFlightTickerHandle);
      state.inFlightTickerHandle = null;
    }
    ctx.ui.setStatus(MCR_STATUS_KEY, "");
    ctx.ui.setStatus(ENERGY_STATUS_KEY, "");
  });
}

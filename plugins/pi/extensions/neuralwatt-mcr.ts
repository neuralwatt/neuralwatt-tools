import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
// `typebox` is aliased by pi's extension loader (jiti) to the bundled copy at
// runtime, so this single-file extension stays dependency-free when installed
// via `pi install npm:@neuralwatt/pi-mcr-extension`. For `vitest` it resolves
// from this package's devDependencies.
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";

// Bump on any user-facing behaviour change. Surfaced in the extension log so a
// session's behaviour can be tied to a specific revision when triaging reports.
//   2.0.0 — honest in-flight chip (tools#33 / inference_frontend#3954):
//           neutral "working…" label, silent grace window, tightened MCR gating.
//   2.1.0 — send the extension version on the wire as X-NW-MCR-Ext-Version so
//           the gateway can log which client revision served a request (server
//           logs previously had no way to tell a user's extension version).
//   2.1.1 — isMCRModel-first guard in the `context` handler so non-MCR models
//           no longer flood the log with `no_session_fp` skips (tools#38).
//           Verified the X-NW-Conversation-ID header is re-read live per
//           request by the SDK (registerProvider headers mechanism).
//   2.2.0 — self-contained npm package. The provider's full model list (the
//           old configs/models.json) is now declared inline via
//           registerProvider({ baseUrl, api, compat, models }), so the
//           extension no longer needs a separate models.json copy. This makes
//           the package installable with `pi install npm:@neuralwatt/pi-mcr-extension`
//           and updatable with `pi update` — the extension file is the only
//           resource the package ships.
//   2.3.0 — rotate X-NW-Conversation-ID on session_tree so each in-session
//           branch gets its own gateway-side session_fp. Pi's branch()
//           reassigns the leaf pointer within the same session file but
//           keeps the session id stable, so before this fix the gateway saw
//           the same conv-id for every branch and MCR state corrupted
//           across siblings (inference_frontend#4111, spiffytech 2026-06-03
//           report). Now the conv-id becomes ``${sessionId}:${newLeafId}``
//           on branch nav and stays bare on session boot.
//   2.4.0 — dual-instance guard + post-drop stale-window self-heal (tools#44,
//           forensics 2026-06-09). Pi auto-loads
//           ~/.pi/agent/extensions/neuralwatt-mcr.ts IN ADDITION to any
//           ``-e <path>`` copy, so two copies — potentially different
//           versions — race the same drop-protocol session (observed: every
//           log event doubled, 2.3.0 + 2.1.1 both live, 3-hour runaway with
//           the outbound window frozen at a 114-message snapshot while new
//           local turns never went out). Guard: first activation claims a
//           process-global sentinel on globalThis; later activations register
//           nothing and log ``dual_instance_blocked``. Invariant: if the
//           outgoing post-drop window signature repeats while the local
//           history grows (STALE_WINDOW_HEAL_REPEATS consecutive requests),
//           reset the drop bookkeeping and send the FULL history
//           (``stale_window_self_heal``) so the server re-establishes
//           stored_through. No wire-format changes otherwise.
//   2.5.0 — register a local `mcr_lookup` placeholder stub
//           (inference_frontend#4039). On mixed agentic turns the gateway
//           forwards the model's server-side `mcr_lookup` tool call to the
//           client by design (the gateway resolves the hash itself and
//           replaces the client's placeholder tool_result with the real
//           content on the NEXT request — cross-turn injection). Pi had no
//           such tool registered, so it errored locally and rendered
//           "Tool mcr_lookup not found" in the transcript — alarming but
//           benign (prod gateway logs show every placeholder replaced and
//           the model consuming the recalled content). The stub returns a
//           short neutral placeholder and never resolves the hash; this is
//           purely cosmetic — the gateway repairs the conversation either
//           way.
//   2.5.1 — dual-instance guard: stop the permanent-lockout false positive
//           (Nico, 2026-06-12). Pi re-runs every extension factory IN-PROCESS
//           on /new, /resume, fork and /reload (AgentSessionRuntime
//           teardownCurrent → createRuntime → resourceLoader.reload() →
//           loadExtensions; jiti moduleCache:false re-evaluates the module
//           but globalThis persists). The 2.4.0 sentinel was never cleared,
//           so the re-activation was blocked as a "dual instance" while pi
//           had already discarded the prior activation's handlers — leaving
//           ZERO active copies (MCR + the whole neuralwatt provider silently
//           gone) for the rest of the process. Fix: (a) the winner releases
//           the sentinel in its session_shutdown handler — pi emits
//           session_shutdown before every teardown path that precedes a
//           re-load; (b) belt-and-braces heartbeat: the winner stamps the
//           sentinel on every event it handles, and a claimant may STEAL a
//           sentinel whose heartbeat is older than DUAL_INSTANCE_STALE_MS
//           (logged as ``dual_instance_steal_stale``). True dual-load at
//           startup still blocks — both copies activate within milliseconds,
//           so the loser always sees a fresh heartbeat. tools#44 protection
//           preserved; the lockout is gone.
const EXTENSION_VERSION = "2.5.1";

// ── Provider definition (folded in from the former configs/models.json) ─────
// Declaring the full provider config inline lets this extension be a
// self-contained Pi package: `pi install npm:@neuralwatt/pi-mcr-extension`
// registers the provider AND its models with no separate models.json step, and
// `pi update` keeps it current. registerProvider with `models` replaces the
// whole model list for the provider, so this is the single source of truth.
//
// All Neuralwatt models bill by ENERGY, not tokens — cost fields are
// intentionally zeroed (see README "Token cost shows $0.00").
const NEURALWATT_BASE_URL = "https://api.neuralwatt.com/v1";
const NEURALWATT_API = "openai-completions";
const NEURALWATT_COMPAT = {
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: "max_tokens",
} as const;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const NEURALWATT_MODELS = [
  { id: "zai-org/GLM-5.1-FP8", name: "GLM-5.1", reasoning: true, input: ["text"], contextWindow: 202752, maxTokens: 8192, cost: ZERO_COST },
  { id: "glm-5.1-fast", name: "GLM-5.1 Fast", reasoning: false, input: ["text"], contextWindow: 202752, maxTokens: 8192, cost: ZERO_COST },
  { id: "glm-5-fast", name: "GLM-5 Fast", reasoning: false, input: ["text"], contextWindow: 202752, maxTokens: 8192, cost: ZERO_COST },
  { id: "neuralwatt/glm-5.1-long", name: "GLM-5.1 Long (MCR 1M)", reasoning: true, input: ["text"], contextWindow: 1048576, maxTokens: 16384, cost: ZERO_COST },
  { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "kimi-k2.6-fast", name: "Kimi K2.6 Fast", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "neuralwatt/kimi-k2.6-long", name: "Kimi K2.6 Long (MCR 1M)", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 16384, cost: ZERO_COST },
  { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5", reasoning: true, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "kimi-k2.5-fast", name: "Kimi K2.5 Fast", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "Qwen/Qwen3.6-35B-A3B", name: "Qwen3.6 35B", reasoning: true, input: ["text", "image"], contextWindow: 131072, maxTokens: 8192, cost: ZERO_COST },
  { id: "Qwen/Qwen3.5-397B-A17B-FP8", name: "Qwen3.5 397B FP8", reasoning: true, input: ["text"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5", reasoning: true, input: ["text"], contextWindow: 196608, maxTokens: 8192, cost: ZERO_COST },
  { id: "mistralai/Devstral-Small-2-24B-Instruct-2512", name: "Devstral Small 2 24B", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 8192, cost: ZERO_COST },
  { id: "openai/gpt-oss-20b", name: "GPT OSS 20B", reasoning: true, input: ["text"], contextWindow: 16384, maxTokens: 8192, cost: ZERO_COST },
] as const;

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

// ── Dual-instance guard (tools#44) ──────────────────────────────────────────
// Pi AUTO-LOADS ~/.pi/agent/extensions/neuralwatt-mcr.ts in addition to any
// `-e <path>` copy, so two copies of this module — potentially DIFFERENT
// VERSIONS — can be activated in one process. Two drop-protocol state machines
// racing on the same session produced the 2026-06-09 catastrophic runaway
// (every extension log event emitted twice, versions 2.3.0 + 2.1.1
// simultaneously active). First activation wins; any later activation must
// register nothing and say so loudly.
//
// The sentinel MUST live on globalThis, NOT module scope: two module copies
// loaded from different paths each get their own module scope (exactly what
// the dual-load evidence shows), so a module-scoped flag can never see the
// other copy. globalThis is the only scope both copies share.
//
// 2.5.1 — the sentinel is no longer permanent. Pi re-runs every extension
// factory IN-PROCESS on /new, /resume, fork and /reload (the old runner is
// torn down and a fresh load pass re-evaluates this module; globalThis
// survives the pass). A never-cleared sentinel therefore blocked every
// re-activation after the first, with zero copies left registered. Two
// complementary releases fix that without re-opening tools#44:
//   (a) the winner deletes the sentinel in its session_shutdown handler —
//       pi emits session_shutdown to the old runner before every teardown
//       path that precedes a re-load;
//   (b) the winner stamps sentinel.heartbeatTs on every event it handles,
//       and a claimant may steal a sentinel whose heartbeat is older than
//       DUAL_INSTANCE_STALE_MS (covers hosts that reload resources without
//       emitting session_shutdown, e.g. the SDK's resourceLoader.reload()).
// A genuine dual-load (auto-load + -e copy in ONE load pass) still blocks:
// both copies activate within milliseconds, so the loser always sees a
// fresh heartbeat.
const DUAL_INSTANCE_SENTINEL_KEY = "__NEURALWATT_MCR_ACTIVE__";

// A prior activation whose heartbeat is older than this is considered dead
// (pi discarded its runner without the session_shutdown release firing) and
// may be replaced. Copies racing within one load pass claim within
// milliseconds, so 30s cannot misfire on a live dual-load.
const DUAL_INSTANCE_STALE_MS = 30_000;

interface DualInstanceSentinel {
  version: string;
  module: string;
  ts: string;
  /** Unique id of the activation holding the claim (2.5.1+). */
  activationId?: string;
  /** Last time the holder handled an event, ms epoch (2.5.1+). */
  heartbeatTs?: number;
}

// Unique per-ACTIVATION ownership token (never memoized — see the note at
// the claim site in the default export). Defensive fallback mirrors the
// guard's fail-open posture: id generation must never break activation.
function newActivationId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

// Best-effort hint of which file this module copy was loaded from, so the
// dual_instance_blocked log can tell the auto-loaded copy from the -e one.
function moduleHint(): string {
  try {
    return typeof import.meta?.url === "string" ? import.meta.url : "unknown";
  } catch {
    return "unknown";
  }
}

// Claim the process-global activation sentinel. Returns the already-active
// instance's sentinel when another LIVE copy won (caller must NOT register),
// or null when this copy holds the claim — fresh, stolen-stale, or
// fail-open — and may register normally.
//
// Staleness: a sentinel whose heartbeat is older than DUAL_INSTANCE_STALE_MS
// belongs to an activation pi already discarded (see the release notes on
// DUAL_INSTANCE_SENTINEL_KEY) — steal it and log `dual_instance_steal_stale`.
// A sentinel WITHOUT a heartbeat (written by a ≤2.5.0 copy) is never stolen:
// that copy never refreshes, so "stale" cannot be distinguished from "live",
// and a mixed-version install is exactly the tools#44 dual-load we must keep
// blocking.
//
// Resilience: a frozen/sealed globalThis (or any other exotic environment
// where the read/write throws) must NEVER break activation — fail OPEN to
// registering and log the anomaly. A doubly-registered extension is the
// known-bad state we already survived; a never-registered one is strictly
// worse (no MCR at all).
function claimDualInstanceSentinel(
  activationId: string,
): DualInstanceSentinel | null {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const existing = g[DUAL_INSTANCE_SENTINEL_KEY];
    if (existing && typeof existing === "object") {
      const prior = existing as DualInstanceSentinel;
      const heartbeatAge =
        typeof prior.heartbeatTs === "number"
          ? Date.now() - prior.heartbeatTs
          : null;
      if (heartbeatAge === null || heartbeatAge <= DUAL_INSTANCE_STALE_MS) {
        return prior;
      }
      nwlog("dual_instance_steal_stale", {
        prior: {
          version: prior.version,
          module: prior.module,
          ts: prior.ts,
          heartbeat_age_ms: heartbeatAge,
        },
        claimant: { version: EXTENSION_VERSION, module: moduleHint() },
      });
      // fall through to claim
    }
    const sentinel: DualInstanceSentinel = {
      version: EXTENSION_VERSION,
      module: moduleHint(),
      ts: new Date().toISOString(),
      activationId,
      heartbeatTs: Date.now(),
    };
    g[DUAL_INSTANCE_SENTINEL_KEY] = sentinel;
    return null;
  } catch (err) {
    nwlog("dual_instance_guard_anomaly", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// Refresh the heartbeat — called from every event handler the winner
// registers. Ownership-checked so a late event on an already-torn-down
// runner can never freshen (or resurrect) a claim it no longer holds.
function touchDualInstanceSentinel(activationId: string): void {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const sentinel = g[DUAL_INSTANCE_SENTINEL_KEY] as
      | DualInstanceSentinel
      | undefined;
    if (sentinel && typeof sentinel === "object" && sentinel.activationId === activationId) {
      sentinel.heartbeatTs = Date.now();
    }
  } catch {
    // never break a handler on guard bookkeeping
  }
}

// Release the claim on session_shutdown so the re-activation pi performs on
// /new, /resume, fork and /reload registers cleanly. Ownership-checked: a
// blocked copy (which never claimed) and a superseded activation must not
// delete the current holder's sentinel.
function releaseDualInstanceSentinel(activationId: string): void {
  try {
    const g = globalThis as unknown as Record<string, unknown>;
    const sentinel = g[DUAL_INSTANCE_SENTINEL_KEY] as
      | DualInstanceSentinel
      | undefined;
    if (sentinel && typeof sentinel === "object" && sentinel.activationId === activationId) {
      delete g[DUAL_INSTANCE_SENTINEL_KEY];
    }
  } catch {
    // never break shutdown on guard bookkeeping
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
  // tools#44 post-drop stale-window invariant bookkeeping. From the previous
  // drop-applying request: a cheap signature of the outgoing window
  // (length + last-message identity), the local history length at that
  // request, and how many CONSECUTIVE requests have tripped the
  // frozen-while-growing condition. See the invariant block in the
  // ``context`` handler.
  prevWindowSig: string | null;
  prevLocalLen: number;
  staleWindowRepeats: number;
  // #4111: pi's in-session ``SessionManager.branch()`` (`session-manager.js:913`)
  // reassigns the leaf pointer within the same session file but does NOT
  // change the session id. Without this field we'd send the gateway the
  // same ``X-NW-Conversation-ID`` for every branch of a session, the
  // gateway would derive the same ``session_fp``, and MCR's persisted refs,
  // manifest, and durable pointers would commingle across branches —
  // confusing the model into amnesia loops (spiffytech 2026-06-03 report,
  // 4 traces sharing pi session id ``019e8e34…`` and prod ``session_fp``
  // ``3bb342a0…``). Carrying the active branch's leaf id here lets us
  // compose a per-branch conv id ``${sessionId}:${leafId}`` so each branch
  // gets its own gateway-side session_fp.
  //
  // Set in the ``session_tree`` handler when the user navigates to a
  // different branch; cleared in ``session_start`` so a fresh pi
  // invocation always starts at the bare ``sessionId``. Reused by
  // ``before_provider_request`` on every outbound request (which re-derives
  // the env var so the SDK re-reads ``process.env`` and the wire sees the
  // up-to-date value).
  activeBranchLeafId: string | null;
  // In-flight request UX. When an MCR request is sent we record the wall-clock
  // send time so the chip can surface a neutral "working…" indicator on long
  // waits, and cleared on the first ``message_update`` / ``message_end``.
  //
  // HONESTY NOTE (tools#33 / inference_frontend#3954): this is a wall-clock
  // proxy, NOT a real compaction signal. The extension cannot observe whether
  // the gateway is actually compacting — see ``markRequestSent`` for why Pi's
  // API doesn't surface the gateway's ``mcr-status`` SSE frames. So the chip
  // must NOT claim "optimizing context"; it can only honestly say a request is
  // in flight. We also stay silent for the first few seconds so ordinary turns
  // (the ~96% with no compaction) show nothing at all.
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
  prevWindowSig: null,
  prevLocalLen: 0,
  staleWindowRepeats: 0,
  activeBranchLeafId: null,
  inFlightSince: null,
  inFlightTickerHandle: null,
};

// Track the current Pi session ID to guard against double session_start
// events (where session_start fires without a preceding session_shutdown).
// When the session ID hasn't changed, the destructive state reset is
// skipped — in-flight MCR state is still valid.
let lastSessionId: string | null = null;

// How often to refresh the chip while the in-flight indicator is showing, so
// the elapsed counter advances visibly. 500ms is fast enough to feel live but
// well below the refresh budget of Pi's footer.
const IN_FLIGHT_TICK_MS = 500;

// Honesty grace window (tools#33 / inference_frontend#3954): suppress the
// in-flight indicator for the first few seconds of every request. Large MCR
// prompts (100k+ tokens) have a naturally long prefill/TTFT — 10-60s — on
// EVERY turn, with no compaction happening on the ~96% that don't compact.
// The old chip labelled that ordinary latency "optimizing context…" for the
// whole window, which read as "MCR is making every prompt slow" and drove
// churn. We can't tell prefill from compaction (no SSE phase signal reaches
// the extension), so the only honest move is: say nothing until the wait is
// long enough that the user genuinely wants reassurance the model isn't hung,
// and even then use a neutral label that doesn't assert MCR is doing work.
const IN_FLIGHT_GRACE_MS = 6000;

// Recognise ONLY the MCR-backed aliases. The MCR pipeline (server-side
// compaction + 1M virtual context + the X-MCR-* response protocol) runs only
// for the `neuralwatt/…-long` aliases; the base-model and fast/flex IDs route
// straight to the provider with no compaction.
//
// tools#33: the earlier predicate also matched `zai-org/`, `moonshotai/`,
// `glm-5`, and `kimi-k2`, so every fast/flex alias and direct base-model call
// lit the in-flight chip and ran the context-drop / fp handlers — none of which
// apply off-MCR. Nico reported "optimizing context" on non-long models. The
// client always selects the alias (never the forwarded base name), so matching
// the alias shape is sufficient and correct. This narrows every call site
// (chip gating, context-drop, fp-set, compaction-suppression) to MCR-only,
// which is the intended behaviour for all of them.
function isMCRModel(modelId: string): boolean {
  return modelId.includes("neuralwatt/") || modelId.endsWith("-long");
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

// Render an in-flight elapsed-time stamp for the chip. Short formats (<10s →
// "1.4s", >=10s → "12s", >=60s → "1m 5s") keep the chip from growing wide
// enough to push other footer widgets off-screen.
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

type ConversationIdSource = "pi-session" | "pi-session-branched" | "uuid-fallback";

function resolveConversationId(
  ctx: ExtensionContext,
  branchLeafId?: string | null,
): { id: string; source: ConversationIdSource } {
  // Preferred source: Pi's own session id. Stable across auto-compact in a
  // single `pi` session, distinct across sessions, naturally string-form.
  //
  // #4111: when ``branchLeafId`` is supplied (the user navigated to a
  // different branch in pi's session tree), compose ``${sessionId}:${leafId}``
  // so each branch within a single pi session gets its own conversation
  // identity on the wire. Pi's in-session ``branch()`` doesn't change the
  // session id (same JSONL file), so without this suffix every branch would
  // share one gateway-side ``session_fp`` and MCR state would commingle —
  // observed as model amnesia and lookup-recall pollution in the
  // spiffytech 2026-06-03 report. Subsequent ``branchLeafId`` updates from
  // the ``session_tree`` event keep the wire id in lock-step with the
  // active branch; the bare ``sessionId`` is restored on session boot.
  try {
    const piSessionId = ctx.sessionManager?.getSessionId?.();
    if (
      typeof piSessionId === "string" &&
      isWellFormedConversationId(piSessionId)
    ) {
      if (
        typeof branchLeafId === "string" &&
        branchLeafId.length > 0 &&
        isWellFormedConversationId(`${piSessionId}:${branchLeafId}`)
      ) {
        return {
          id: `${piSessionId}:${branchLeafId}`,
          source: "pi-session-branched",
        };
      }
      return { id: piSessionId, source: "pi-session" };
    }
  } catch {
    // fall through to uuid fallback
  }
  return { id: getUuidFallback(), source: "uuid-fallback" };
}

// ── Post-drop stale-window invariant (tools#44) ─────────────────────────────
// After the extension honors a server context-drop, the outgoing window must
// KEEP ADVANCING as new local turns land. The 2026-06-09 forensics show the
// opposite: the outbound window froze at a 114-message snapshot for 35-40
// minute stretches while 575+ new local turns piled up unsent (a fresh 25KB
// tool result recorded locally was absent from the request sent 42ms later),
// and the server-side breaker fired ~24k times into the stale window with
// zero effect. The freeze is not reproduced under a debugger, so this is a
// HARDENING invariant: detect the failure class at request time and self-heal
// loudly, rather than point-fix a mechanism we can't observe.
//
// Trigger (two-sided, false-positive-safe): the outgoing-window signature is
// IDENTICAL to the previous request's WHILE the local history has GROWN since
// that request. A pure retry (identical window, no new local turns) does not
// trigger; a healthy window advances its tail every turn and never matches.
// After STALE_WINDOW_HEAL_REPEATS consecutive triggers, reset the drop
// bookkeeping and send the FULL local history — the server re-establishes
// stored_through from it. Healing resets the tracking state, so a re-heal
// needs a fresh freeze (no heal loop). Zero wire-format changes otherwise.
const STALE_WINDOW_HEAL_REPEATS = 2;

// Cheap identity signature of an outgoing message window: window length plus
// role and content length of the LAST message. Deliberately not a full hash —
// the invariant only needs "did the window visibly advance?", and a healthy
// post-drop window keeps its newest local message at the tail, so any new
// turn flips the signature.
function windowSignature(msgs: Array<unknown>): string {
  if (msgs.length === 0) return "0";
  const last = msgs[msgs.length - 1] as {
    role?: unknown;
    type?: unknown;
    content?: unknown;
  };
  const role = String(last?.role ?? last?.type ?? "?");
  let contentLen = -1;
  try {
    const content = last?.content;
    contentLen =
      typeof content === "string"
        ? content.length
        : JSON.stringify(content ?? null).length;
  } catch {
    // unserializable content — keep -1; still a stable marker for "same shape"
  }
  return `${msgs.length}:${role}:${contentLen}`;
}

// ── mcr_lookup placeholder stub (inference_frontend#4039) ───────────────────
// On MCR (`-long`) aliases the gateway advertises a server-side recall tool
// named `mcr_lookup`. On mixed agentic turns the model's `mcr_lookup`
// tool_call is forwarded to the client verbatim BY DESIGN: the gateway
// resolves the hash server-side, caches the content, and on the NEXT request
// replaces the client's placeholder tool_result with the real recalled
// content ("cross-turn injection", inference_frontend#4039). Pi has no such
// tool, so without this stub it errors locally and renders
// "Tool mcr_lookup not found" in the transcript — alarming but benign.
//
// The stub must NEVER try to resolve the hash itself: the public client
// protocol spec (neuralwatt-tools docs, mcr-context-drop-client-protocol)
// forbids client-side resolution — recall is the gateway's job. It returns
// this PLACEHOLDER, which the gateway overwrites via cross-turn injection on
// the next request. Keep the text short and stable: it may transiently reach
// the model if injection misses a turn, so it must not look like real
// recalled content and should hint that the content arrives next turn.
const MCR_LOOKUP_PLACEHOLDER =
  "[recall delegated to server — content is injected by the gateway on the next turn]";

const MCR_LOOKUP_PARAMS = Type.Object(
  {
    // Single required param, matching the gateway's tool definition so the
    // forwarded call passes client-side validation.
    hash: Type.String({
      description:
        "Content hash of the compacted range to recall (resolved by the gateway, not the client).",
    }),
  },
  // Defensive: the gateway owns this tool's schema. Tolerate any extra
  // params a future gateway revision may add instead of failing validation.
  { additionalProperties: true },
);

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
  // ── Dual-instance guard (tools#44): first LIVE activation wins ──
  // Claim the process-global sentinel BEFORE registering anything (provider,
  // handlers, env seeds). If another copy of this extension is already live
  // in this process — pi auto-loads ~/.pi/agent/extensions/neuralwatt-mcr.ts
  // in addition to any `-e <path>` copy — register NOTHING: a second
  // drop-protocol state machine racing the first on the same session is the
  // proven mechanism behind the 2026-06-09 runaway. Log loudly to both the
  // extension log (greppable forensics) and stderr (visible interactively).
  // A STALE claim (prior activation torn down without releasing) is stolen
  // instead — see claimDualInstanceSentinel.
  //
  // NOT getUuidFallback(): that id is memoized per-process (by design, for
  // the conversation-id boot seed), but the activation id must be unique PER
  // ACTIVATION — it is the ownership token that lets touch/release tell the
  // current claim holder from a superseded one in the same process.
  const activationId = newActivationId();
  const activeInstance = claimDualInstanceSentinel(activationId);
  if (activeInstance) {
    const loser = { version: EXTENSION_VERSION, module: moduleHint() };
    nwlog("dual_instance_blocked", { winner: activeInstance, loser });
    console.error(
      `[neuralwatt-mcr] DUAL INSTANCE BLOCKED: extension v${loser.version} ` +
        `(${loser.module}) did NOT register — v${activeInstance.version} ` +
        `(${activeInstance.module}) is already active in this process. ` +
        `If the two paths differ, two copies are loading (pi auto-loads ` +
        `~/.pi/agent/extensions/neuralwatt-mcr.ts in addition to any ` +
        `-e <path> copy) — remove one. If the paths are identical or you ` +
        `have no -e copy, this is likely a same-process re-activation and ` +
        `should self-resolve from v2.5.1 — please report if it persists ` +
        `(see neuralwatt-tools#44).`,
    );
    return;
  }

  const MCR_STATUS_KEY = "nw-mcr";
  const ENERGY_STATUS_KEY = "nw-energy";

  // ── Outbound header wiring (X-NW-Conversation-ID, X-NW-MCR-Ext-Version) ──
  // pi-coding-agent's `before_provider_request` is a *body* hook — the
  // earlier `payload.headers[...]` mutation reached extension memory only,
  // never the HTTP wire. The documented per-request header path is
  // `pi.registerProvider({ headers })`, whose values are env-var NAMES.
  //
  // VERIFIED against pi-coding-agent 0.73.x (do not "fix" the bare names — see
  // tools#38 and the #32→#35 revert that re-broke and then un-broke this):
  //   * sdk.js `streamFn` calls `modelRegistry.getApiKeyAndHeaders(model)` on
  //     EVERY stream.
  //   * That calls `resolveHeadersOrThrow` -> `resolveConfigValueUncached`,
  //     which returns `process.env[value] || value`
  //     (dist/core/resolve-config-value.js).
  // So a header value of the *bare* name "X_NW_CONVERSATION_ID" resolves to
  // the live `process.env["X_NW_CONVERSATION_ID"]` on every request. A
  // "$"-prefixed value ("$X_NW_CONVERSATION_ID", as #32 tried) does NOT match
  // any env var and is sent as the literal string — that was the bug #35
  // reverted. Net: real HTTP headers, re-read live per request, no body touch,
  // no APC impact. Both headers below ride this same mechanism.
  //
  // Boot order: we seed the env var with a UUID at extension load so any
  // request fired before `session_start` upgrades it still carries *some*
  // stable, per-process id. `session_start` (fires before the first provider
  // request) and `before_provider_request` both upgrade it to Pi's stable
  // per-invocation session id (see resolveConversationId). Subsequent requests
  // in the same `pi` invocation reuse the upgraded value — invocation-stable
  // session_fp by construction, sent on the wire as X-NW-Conversation-ID.
  const CONV_ID_ENV = "X_NW_CONVERSATION_ID";
  if (!process.env[CONV_ID_ENV]) {
    process.env[CONV_ID_ENV] = getUuidFallback();
  }
  // X-NW-MCR-Ext-Version (2.1.0): surface the client extension
  // version on the wire so the gateway can log which revision served a
  // request — server logs previously had no way to tell a user's version.
  // Unlike the conversation id, the version is static for the life of the
  // process (it never changes at runtime), so we seed it once at load and
  // never touch it again — no upgrade-on-hook logic needed.
  const EXT_VERSION_ENV = "X_NW_MCR_EXT_VERSION";
  process.env[EXT_VERSION_ENV] = EXTENSION_VERSION;
  // Full provider definition. Supplying `models` makes registerProvider
  // REPLACE the provider's entire model list, so this declaration is the single
  // source of truth — no ~/.pi/agent/models.json copy needed (folded in at
  // 2.2.0). baseUrl/api/compat are stated explicitly because, with models
  // present, this is the canonical entry rather than an override of a
  // models.json-derived one. apiKey/headers are env-var NAMES, resolved live
  // per request by the SDK (see the header-wiring note above).
  pi.registerProvider("neuralwatt", {
    baseUrl: NEURALWATT_BASE_URL,
    api: NEURALWATT_API,
    apiKey: "NEURALWATT_API_KEY",
    headers: {
      "X-NW-Conversation-ID": CONV_ID_ENV,
      "X-NW-MCR-Ext-Version": EXT_VERSION_ENV,
    },
    models: NEURALWATT_MODELS.map((m) => ({ ...m, compat: NEURALWATT_COMPAT })),
  });

  // ── mcr_lookup placeholder stub (inference_frontend#4039) ──
  // See the MCR_LOOKUP_PLACEHOLDER block above for the full design note.
  // Registering the tool keeps pi's tool loop from erroring with
  // "Tool mcr_lookup not found" when the gateway forwards the model's
  // server-side recall call; the placeholder result is replaced by the
  // gateway on the next request (cross-turn injection). This stub must not —
  // and does not — attempt to resolve the hash.
  pi.registerTool({
    name: "mcr_lookup",
    label: "MCR server-side recall",
    description:
      "Server-side recall of MCR-compacted conversation content. The Neuralwatt " +
      "gateway resolves this tool itself; this local stub only returns a " +
      "placeholder that the gateway replaces on the next turn. Only meaningful " +
      "on Neuralwatt MCR (-long) models — never call it directly.",
    parameters: MCR_LOOKUP_PARAMS,
    // Defensive shim: never let client-side schema validation reject a call
    // the gateway will resolve anyway. Coerce `hash` to a string and ignore
    // any extra params.
    prepareArguments(args: unknown) {
      const raw = (args ?? {}) as Record<string, unknown>;
      return {
        hash: typeof raw.hash === "string" ? raw.hash : String(raw.hash ?? ""),
      };
    },
    async execute(_toolCallId, params) {
      nwlog("mcr_lookup_stub", {
        hash_prefix: String(params.hash).slice(0, 12),
      });
      return {
        // PLACEHOLDER ONLY — overwritten server-side via cross-turn injection.
        content: [{ type: "text", text: MCR_LOOKUP_PLACEHOLDER }],
        details: { hash: params.hash, placeholder: true },
      };
    },
  });

  function updateStatusBar(ctx: ExtensionContext) {
    // In-flight indicator (tools#33 / inference_frontend#3954). HONESTY RULES:
    //
    //  * The extension cannot observe whether the gateway is compacting (Pi
    //    doesn't surface the ``mcr-status`` SSE frames — see markRequestSent).
    //    So we NEVER claim "optimizing context"; we only ever say a request is
    //    in flight ("working…").
    //  * We stay completely silent for the first IN_FLIGHT_GRACE_MS so normal
    //    turns — including the long-but-uncompacted prefill that dominates real
    //    usage — show nothing. Only a genuinely long wait surfaces the neutral
    //    reassurance that the model hasn't hung.
    //  * Once real model output starts, ``markStreamProducing`` clears
    //    ``inFlightSince`` and the chip reverts to the standard MCR view.
    const inFlightElapsedMs =
      state.inFlightSince !== null ? Date.now() - state.inFlightSince : 0;
    if (
      state.inFlightSince !== null &&
      inFlightElapsedMs >= IN_FLIGHT_GRACE_MS
    ) {
      const fpPrefix = state.sessionFp
        ? `MCR ${state.sessionFp.slice(0, 8)} | `
        : "MCR | ";
      ctx.ui.setStatus(
        MCR_STATUS_KEY,
        `${fpPrefix}working… ${formatElapsed(inFlightElapsedMs)}`,
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

  // Lifecycle helpers for the in-flight indicator. We bracket the wait window
  // with ``markRequestSent`` (on before_provider_request) and
  // ``markStreamProducing`` (on the first message_update / message_end that
  // carries real model output). The elapsed counter advances via a
  // ``setInterval`` that re-calls ``updateStatusBar`` every ~0.5s.
  //
  // ── WHY THIS IS A NEUTRAL "working…" PROXY, NOT A REAL MCR PHASE SIGNAL ──
  //
  // The gateway (inference_frontend #3916) emits the ground truth as
  // ``event: mcr-status`` SSE frames carrying {phase: compacting | warming |
  // idle, elapsed_ms}. The ideal chip would show "optimizing context…" ONLY
  // while a ``compacting`` phase is live. That is NOT achievable from a Pi
  // extension on the version this targets (Pi v0.72/0.73), verified against
  // the published type defs:
  //
  //   1. The only stream hook is ``message_update``, whose payload is
  //      ``assistantMessageEvent: AssistantMessageEvent`` (pi-ai types.d.ts).
  //      That union is closed to text/thinking/toolcall/start/done/error —
  //      there is no member that can carry a raw ``mcr-status`` frame.
  //   2. There is no "raw SSE frame" / "stream event" hook anywhere on
  //      ``ExtensionAPI`` (pi-coding-agent extensions/types.d.ts): the event
  //      surface is session/agent/turn/message/tool lifecycle only.
  //   3. The neuralwatt provider streams through pi-ai's openai-completions
  //      handler, which consumes the response via the official ``openai`` SDK
  //      (``client.chat.completions.create(...).withResponse()``). The SDK's
  //      decoder yields only typed ``chat.completion.chunk`` objects; any SSE
  //      frame with ``event: mcr-status`` is dropped by the SDK before pi-ai —
  //      and therefore the extension — can ever see it.
  //
  // So the extension genuinely cannot tell prefill from compaction. Claiming
  // "optimizing context" would be a lie on the ~96% of turns where nothing is
  // compacted (the churn driver in #3954). The honest behaviour is: neutral
  // "working…" label, only after a grace window. Path A (real phase-driven
  // chip) is blocked on an upstream Pi capability: a hook that surfaces raw
  // provider SSE events (or an OpenAI-compat passthrough for unknown event
  // types) to extensions. Track that as a Pi feature request; revisit here
  // once it ships.
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

  pi.on("session_start", async (_event, ctx) => {
    touchDualInstanceSentinel(activationId);
    // #4111: clear the active branch suffix at session boot so a fresh pi
    // invocation always starts with the bare session id on the wire. Branch
    // navigation later in the session (``session_tree``) re-pins this.
    state.activeBranchLeafId = null;

    // Upgrade X_NW_CONVERSATION_ID to Pi's stable session-id as early as
    // possible — session_start fires before any provider request and is the
    // earliest hook with ctx.
    const { id: conversationId, source: conversationIdSource } =
      resolveConversationId(ctx, state.activeBranchLeafId);
    process.env[CONV_ID_ENV] = conversationId;

    // Guard against double-fire: Pi sometimes emits session_start without
    // a preceding session_shutdown. When the session ID hasn't changed,
    // skip the destructive state reset — in-flight MCR state is still
    // valid.
    //
    // Assumption of the "unknown" fallback: if getSessionId() is unavailable,
    // two genuinely different sessions that BOTH lack an id AND have no
    // intervening session_shutdown collapse to the same "unknown" sentinel and
    // are treated as a duplicate (state reset skipped). This is acceptable —
    // such a back-to-back idless pair is indistinguishable from a double-fire,
    // and session_shutdown clears lastSessionId in the normal case.
    const newSessionId = ctx.sessionManager?.getSessionId?.() ?? "unknown";
    if (newSessionId === lastSessionId) {
      nwlog("session_start_duplicate", {
        session_id: newSessionId,
        source: conversationIdSource,
      });
      return;
    }

    nwlog("session_start", {
      extension_version: EXTENSION_VERSION,
      session_id: newSessionId,
      source: conversationIdSource,
    });
    lastSessionId = newSessionId;

    state.sessionFp = null;
    state.safeDropBefore = 0;
    state.storedThrough = 0;
    state.totalEnergyJoules = 0;
    state.sessionTurns = 0;
    state.contextTokens = 0;
    state.lastMcrMeta = null;
    state.lastEnergy = null;
    state.prevWindowSig = null;
    state.prevLocalLen = 0;
    state.staleWindowRepeats = 0;
    state.inFlightSince = null;
    if (state.inFlightTickerHandle !== null) {
      clearInterval(state.inFlightTickerHandle);
      state.inFlightTickerHandle = null;
    }
    // Do NOT null uuidFallback here — it persists across auto-compact
    // within one `pi` invocation. Nulling it on session_start causes
    // conversation ID thrashing during double-start races (the root cause
    // of the "two brains" MCR session_fp flip).
    ctx.ui.setStatus(MCR_STATUS_KEY, "");
    ctx.ui.setStatus(ENERGY_STATUS_KEY, "");
  });

  pi.on("after_provider_response", async (event, ctx) => {
    touchDualInstanceSentinel(activationId);
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

  // Clear the in-flight indicator on the first message_update for an MCR
  // model — at that point real model tokens are flowing, the "is it hung?"
  // perception is gone, and the chip should revert to the standard
  // MCR-fingerprint view. The MessageUpdateEvent fires for any assistant
  // streaming update (text/thinking/toolcall deltas); we don't need to narrow
  // further since any of these prove the wait is over.
  pi.on("message_update", async (event, ctx) => {
    touchDualInstanceSentinel(activationId);
    if (event.message.role !== "assistant") return;
    if (!isMCRModel(ctx.model?.id || "")) return;
    markStreamProducing(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    touchDualInstanceSentinel(activationId);
    if (event.message.role !== "assistant") return;
    if (!isMCRModel(ctx.model?.id || "")) return;

    // Backstop — if a response was short enough that no message_update ever
    // fired, message_end is the latest possible chance to clear the indicator
    // before it gets stale.
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
      pi.appendEntry("neuralwatt-energy", { energy_joules: energy.energy_joules });
      if (energy.mcr) {
        state.sessionTurns = energy.mcr.session_turns;
        state.contextTokens = energy.mcr.context_tokens;
      }
    }

    updateStatusBar(ctx);
  });

  pi.on("context", async (event, ctx) => {
    touchDualInstanceSentinel(activationId);
    const modelId = ctx.model?.id || "";
    const numMsgs = event.messages.length;

    // isMCRModel must be the FIRST guard. The `context` event fires on every
    // turn for every model, including non-MCR ones (deepseek-v4-pro,
    // GLM-5.1-FP8, Kimi-K2.6). Those never carry MCR state, so they always
    // tripped the `no_session_fp` guard below and flooded the log with
    // `context_skip` entries that masked real MCR issues. Filtering non-MCR
    // models out first — silently, with no log line — keeps the log signal
    // about MCR sessions only. Behaviour for MCR models is unchanged.
    if (!isMCRModel(modelId)) {
      return;
    }
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

    // ── Post-drop stale-window invariant (tools#44) ──
    // The window we are about to send must keep advancing as new local turns
    // land. Two-sided trigger: signature identical to the PREVIOUS request's
    // outgoing window WHILE the local history has grown since that request.
    // A pure retry (no local growth) resets the streak; a healthy window's
    // tail carries the newest local message, so growth flips the signature.
    const windowSig = windowSignature(filtered);
    const localLen = event.messages.length;
    const frozenWhileGrowing =
      state.prevWindowSig !== null &&
      windowSig === state.prevWindowSig &&
      localLen > state.prevLocalLen;
    state.staleWindowRepeats = frozenWhileGrowing
      ? state.staleWindowRepeats + 1
      : 0;

    if (state.staleWindowRepeats >= STALE_WINDOW_HEAL_REPEATS) {
      // SELF-HEAL: the outgoing window is provably stale (frozen for
      // STALE_WINDOW_HEAL_REPEATS consecutive requests while local history
      // grew). Reset the drop bookkeeping and send the FULL local history on
      // this request — the server re-establishes stored_through /
      // safe_drop_before from it via the normal response headers. Tracking
      // state resets too, so the next heal needs a fresh freeze (no loop).
      nwlog("stale_window_self_heal", {
        repeats: state.staleWindowRepeats,
        window_len: filtered.length,
        local_len: localLen,
        safe_drop_before: state.safeDropBefore,
        session_fp: state.sessionFp,
      });
      console.error(
        `[neuralwatt-mcr] STALE WINDOW SELF-HEAL: outgoing window frozen at ` +
          `${filtered.length} msgs across ${state.staleWindowRepeats} ` +
          `consecutive requests while local history grew to ${localLen} — ` +
          `resetting drop bookkeeping and sending the full history so the ` +
          `server re-establishes stored_through (neuralwatt-tools#44).`,
      );
      state.safeDropBefore = 0;
      state.storedThrough = 0;
      state.lastMcrMeta = null;
      state.prevWindowSig = null;
      state.prevLocalLen = 0;
      state.staleWindowRepeats = 0;
      updateStatusBar(ctx);
      // No message mutation — the full local history goes out on this request.
      return;
    }

    state.prevWindowSig = windowSig;
    state.prevLocalLen = localLen;

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
    touchDualInstanceSentinel(activationId);
    if (!isMCRModel(ctx.model?.id || "")) return;

    const payload = event.payload as Record<string, unknown>;

    // Start the in-flight indicator. It stays silent for IN_FLIGHT_GRACE_MS;
    // only on a genuinely long wait does it surface a neutral
    // "working… 12s" so the chat UI isn't indistinguishable from a hung
    // model. It deliberately does NOT claim "optimizing context" — the
    // extension can't observe whether compaction is happening (see
    // ``markRequestSent`` for the Pi-API limitation that blocks the real
    // phase signal).
    markRequestSent(ctx);

    // Upgrade the X_NW_CONVERSATION_ID env var (seeded with a UUID at
    // extension load) to Pi's stable per-invocation session id. The SDK
    // re-reads process.env on every stream, so this propagates to the
    // next outbound request as the real X-NW-Conversation-ID HTTP header
    // — no body touch. See the header-wiring block at the top of this fn
    // and pi-header-surface.md for the full mechanism trace.
    //
    // #4111: carry the active branch suffix (set by ``session_tree`` when
    // the user navigates between branches in pi's session tree) so each
    // branch gets a distinct ``session_fp`` on the gateway. Without this,
    // pi's in-session ``branch()`` would silently share gateway state
    // across siblings — the spiffytech amnesia shape.
    const { id: conversationId, source: conversationIdSource } =
      resolveConversationId(ctx, state.activeBranchLeafId);
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
    touchDualInstanceSentinel(activationId);
    if (!isMCRModel(ctx.model?.id || "")) return;
    if (state.sessionFp) {
      nwlog("compaction_cancelled", { session_fp: state.sessionFp });
      return { cancel: true };
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    touchDualInstanceSentinel(activationId);
    // Branch navigation invalidates MCR session state — sessionFp and
    // safeDropBefore are tied to a specific message sequence that no
    // longer matches the new branch. Clear everything and let the
    // next server response repopulate. Energy is replayed from the
    // session log (same as the main provider's session_tree handler).
    state.sessionFp = null;
    state.safeDropBefore = 0;
    state.storedThrough = 0;
    state.totalEnergyJoules = 0;
    state.sessionTurns = 0;
    state.contextTokens = 0;
    state.lastMcrMeta = null;
    state.lastEnergy = null;
    state.prevWindowSig = null;
    state.prevLocalLen = 0;
    state.staleWindowRepeats = 0;

    // #4111: pin the active branch's leaf id so the wire-side
    // X-NW-Conversation-ID becomes ``${sessionId}:${newLeafId}`` for this
    // branch. Without this the gateway derives the same session_fp for
    // every branch within one pi session and MCR state corrupts across
    // siblings (spiffytech 2026-06-03 report). Prefer the event's
    // ``newLeafId`` payload (deterministic, what pi just navigated to);
    // fall back to ``getLeafId()`` if the event shape changes upstream.
    const eventLeafId =
      typeof (event as { newLeafId?: unknown })?.newLeafId === "string"
        ? ((event as { newLeafId: string }).newLeafId)
        : null;
    const fallbackLeafId = ctx.sessionManager?.getLeafId?.() ?? null;
    state.activeBranchLeafId = eventLeafId ?? fallbackLeafId;

    // Re-derive the env var now so any tooling reading it between events
    // (e.g. status-line scripts) sees the branched conv id. The SDK will
    // re-read it on the next stream regardless, so this is just a freshness
    // courtesy — the wire correctness is owned by before_provider_request.
    const { id: conversationId } = resolveConversationId(
      ctx, state.activeBranchLeafId,
    );
    process.env[CONV_ID_ENV] = conversationId;

    // Replay energy events from the session log for the new branch.
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom" &&
        entry.customType === "neuralwatt-energy" &&
        typeof entry.data === "object" &&
        entry.data
      ) {
        state.totalEnergyJoules += (entry.data as { energy_joules: number }).energy_joules || 0;
      }
    }

    nwlog("session_tree", {
      total_energy_replayed: state.totalEnergyJoules,
      branch_leaf_id_prefix: state.activeBranchLeafId
        ? state.activeBranchLeafId.slice(0, 8)
        : null,
    });
    updateStatusBar(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Release the dual-instance claim FIRST (before anything below can
    // throw): pi emits session_shutdown to this (old) runner before every
    // teardown that precedes an in-process re-load (/new, /resume, fork,
    // /reload — AgentSessionRuntime.teardownCurrent / AgentSession.reload),
    // so the re-activation that follows must find the slot free.
    releaseDualInstanceSentinel(activationId);
    nwlog("session_shutdown", {
      final_session_fp: state.sessionFp,
      total_energy_joules: state.totalEnergyJoules,
      session_turns: state.sessionTurns,
    });
    // Clear the session ID guard so the next session_start (which starts
    // a genuinely new session after a shutdown) always performs the full
    // state reset.
    lastSessionId = null;
    // Tear down the in-flight ticker so the interval handle
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

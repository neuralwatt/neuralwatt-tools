// Tests for the Neuralwatt MCR Pi extension.
//
// The extension is shipped as a single .ts file that Pi loads at runtime
// (types are erased). These tests drive the real extension with a mock `pi`
// object, capturing the handlers and provider config it registers, and assert
// the two behaviours hardened in tools#38:
//
//   1. The X-NW-Conversation-ID header is wired so the SDK resolves it from
//      `process.env` live per request (env-var-NAME-as-value mechanism).
//   2. The `context` handler filters non-MCR models FIRST, silently — no
//      `no_session_fp` log noise for deepseek/GLM/Kimi non-MCR turns.
//
// We run each test in an isolated $HOME so the extension's append-only log
// file is observable and does not leak across tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Minimal mock of the Pi ExtensionAPI surface the extension touches ──
type Handler = (event: any, ctx: any) => any;

interface MockPi {
  handlers: Map<string, Handler>;
  providers: Record<string, any>;
  tools: Record<string, any>;
  on: (event: string, handler: Handler) => void;
  registerProvider: (name: string, config: any) => void;
  registerTool: (tool: any) => void;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler>();
  const providers: Record<string, any> = {};
  const tools: Record<string, any> = {};
  return {
    handlers,
    providers,
    tools,
    on(event, handler) {
      // The extension registers some events more than once across refactors;
      // last-registration-wins mirrors how Pi's runner would dispatch the
      // final handler for a given event in this single module.
      handlers.set(event, handler);
    },
    registerProvider(name, config) {
      providers[name] = config;
    },
    registerTool(tool) {
      tools[tool.name] = tool;
    },
  };
}

function makeCtx(modelId: string) {
  return {
    model: { id: modelId },
    sessionManager: { getSessionId: () => "sess-test-1234" },
    ui: { setStatus: () => {} },
  };
}

/**
 * Mirror of the SDK's resolveConfigValue (dist/core/resolve-config-value.js):
 * a header value is treated as an env-var NAME, resolved live to
 * `process.env[name] || name`. This is the exact mechanism that puts the
 * conversation id on the wire, so we assert the extension's registered header
 * values resolve correctly under it.
 */
function resolveConfigValue(value: string): string {
  return process.env[value] || value;
}

// The extension captures its log path from os.homedir() at module load. We
// pin $HOME to a temp dir BEFORE the first import so that capture is stable,
// then clear the single log file between tests for isolation.
let tmpHome: string;
let extDefault: (pi: MockPi) => void;

function logPath(): string {
  return path.join(tmpHome, ".pi", "agent", "extensions", "neuralwatt-mcr.log");
}

function readLog(): string {
  try {
    return fs.readFileSync(logPath(), "utf-8");
  } catch {
    return "";
  }
}

async function loadExtension(): Promise<(pi: MockPi) => void> {
  return extDefault;
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nw-mcr-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome; // Windows homedir source
  fs.mkdirSync(path.join(tmpHome, ".pi", "agent", "extensions"), {
    recursive: true,
  });
  const mod = await import("./neuralwatt-mcr.ts");
  extDefault = mod.default as (pi: MockPi) => void;
});

// tools#44: the dual-instance guard claims a process-global sentinel on
// globalThis at activation. Every test below activates the extension at least
// once, so the sentinel must be cleared between tests or the second test's
// activation would be (correctly!) blocked as a dual instance.
function clearDualInstanceSentinel() {
  delete (globalThis as Record<string, unknown>).__NEURALWATT_MCR_ACTIVE__;
}

// 2.5.3: the cross-activation drop-state cache also lives on globalThis (it
// must survive jiti module re-evaluation across a branch). The test module is
// imported once, so this map persists across tests — clear it for isolation,
// exactly like the dual-instance sentinel above.
function clearDropStateCache() {
  delete (globalThis as Record<string, unknown>).__NEURALWATT_MCR_DROP_STATE_V1__;
}

beforeEach(() => {
  // Reset the env-var seeds and the log between tests. Re-seed the conversation
  // id the same way the extension does at module load (it only seeds once).
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  clearDualInstanceSentinel();
  clearDropStateCache();
  try {
    fs.rmSync(logPath());
  } catch {
    // no log yet
  }
});

afterEach(() => {
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  clearDualInstanceSentinel();
  clearDropStateCache();
});

describe("X-NW-Conversation-ID header wiring", () => {
  it("registers the neuralwatt provider with env-var-name header values", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const cfg = pi.providers["neuralwatt"];
    expect(cfg).toBeTruthy();
    // Header VALUES are env-var NAMES (not literals, not $-prefixed).
    expect(cfg.headers["X-NW-Conversation-ID"]).toBe("X_NW_CONVERSATION_ID");
    expect(cfg.headers["X-NW-MCR-Ext-Version"]).toBe("X_NW_MCR_EXT_VERSION");
    expect(cfg.headers["X-NW-Conversation-ID"].startsWith("$")).toBe(false);
  });

  it("declares the full provider inline (self-contained package — no models.json)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const cfg = pi.providers["neuralwatt"];
    // baseUrl + api must be present so the provider stands alone without a
    // models.json-derived entry to inherit from.
    expect(cfg.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(cfg.api).toBe("openai-completions");
    expect(cfg.apiKey).toBe("NEURALWATT_API_KEY");

    // The model list is registered inline, and the MCR long-context aliases
    // (the whole point of the extension) are present.
    expect(Array.isArray(cfg.models)).toBe(true);
    const ids = cfg.models.map((m: { id: string }) => m.id);
    expect(ids).toContain("neuralwatt/glm-5.1-long");
    expect(ids).toContain("neuralwatt/kimi-k2.6-long");

    // Every model carries the OpenAI-compat shim and zeroed (energy-billed) cost.
    for (const m of cfg.models) {
      expect(m.compat).toMatchObject({ maxTokensField: "max_tokens" });
      expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
  });

  it("seeds X_NW_CONVERSATION_ID so the header resolves to a real value on the first request", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];
    const resolved = resolveConfigValue(headerName);
    // Resolves to the seeded value, NOT the literal env-var name.
    expect(resolved).not.toBe("X_NW_CONVERSATION_ID");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("upgrades the env var to Pi's stable session id on session_start, and the header re-reads it live", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const headerName = pi.providers["neuralwatt"].headers["X-NW-Conversation-ID"];

    const before = resolveConfigValue(headerName);

    const sessionStart = pi.handlers.get("session_start")!;
    await sessionStart({}, makeCtx("neuralwatt/glm-5.1-long"));

    const after = resolveConfigValue(headerName);
    // After session_start the header resolves to Pi's stable session id, and
    // it changed from the boot UUID — proving the live per-request re-read path.
    expect(after).toBe("sess-test-1234");
    expect(after).not.toBe(before);
  });
});

describe("context handler: isMCRModel-first guard", () => {
  it("filters non-MCR models silently — no no_session_fp log noise", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const context = pi.handlers.get("context")!;

    const ret = await context(
      { messages: [{ type: "user" }, { type: "assistant" }] },
      makeCtx("deepseek-v4-pro"),
    );

    expect(ret).toBeUndefined(); // no message mutation
    const log = readLog();
    expect(log).not.toContain("no_session_fp");
    expect(log).not.toContain("not_mcr_model");
    // No context_skip line at all for a non-MCR model.
    expect(log).not.toContain("context_skip");
  });

  it("still logs no_session_fp for an MCR model with no session fp yet", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const context = pi.handlers.get("context")!;

    await context(
      { messages: [{ type: "user" }] },
      makeCtx("neuralwatt/glm-5.1-long"),
    );

    const log = readLog();
    expect(log).toContain("no_session_fp");
  });
});

describe("#4111 in-session branch isolation", () => {
  // Pi's SessionManager.branch() reassigns the leaf pointer within the same
  // session file but does NOT change the session id. Before this fix every
  // branch sent the gateway the same X-NW-Conversation-ID and corrupted MCR
  // state across siblings (spiffytech 2026-06-03 report — 4 traces, same pi
  // session id, same prod session_fp). The fix carries the branch's leaf id
  // as a suffix on the conv id so each branch gets its own gateway-side fp.

  function makeBranchCtx(modelId: string, opts?: {
    sessionId?: string;
    leafId?: string | null;
  }) {
    const sessionId = opts?.sessionId ?? "sess-test-1234";
    let currentLeafId: string | null = opts?.leafId ?? null;
    return {
      model: { id: modelId },
      sessionManager: {
        getSessionId: () => sessionId,
        getLeafId: () => currentLeafId,
        getBranch: () => [],
        setLeafId: (id: string | null) => { currentLeafId = id; },
      },
      ui: { setStatus: () => {} },
    };
  }

  it("session_start uses the bare session id (no leaf suffix)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const sessionStart = pi.handlers.get("session_start")!;
    await sessionStart({}, makeBranchCtx("neuralwatt/glm-5.1-long"));

    // Bare session id — no leaf suffix because no branch has been taken yet.
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234");
  });

  it("session_tree pins the new leaf id into the conv id", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeBranchCtx("neuralwatt/glm-5.1-long");

    // First, boot the session.
    await pi.handlers.get("session_start")!({}, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234");

    // User navigates to a branch — pi emits session_tree with the new leaf
    // id in the event payload.
    const sessionTree = pi.handlers.get("session_tree")!;
    await sessionTree({ newLeafId: "leaf-aaa1" }, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234:leaf-aaa1");

    // User navigates to a DIFFERENT branch (sibling). Conv id updates again.
    await sessionTree({ newLeafId: "leaf-bbb2" }, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234:leaf-bbb2");
  });

  it("falls back to sessionManager.getLeafId() when the event lacks newLeafId", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeBranchCtx(
      "neuralwatt/glm-5.1-long", { leafId: "leaf-from-mgr" },
    );

    await pi.handlers.get("session_start")!({}, ctx);
    // Older pi versions might not include newLeafId on the event payload —
    // the handler must still produce a branched conv id.
    await pi.handlers.get("session_tree")!({}, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe(
      "sess-test-1234:leaf-from-mgr",
    );
  });

  it("before_provider_request preserves the active branch leaf in the conv id", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeBranchCtx("neuralwatt/glm-5.1-long");

    await pi.handlers.get("session_start")!({}, ctx);
    await pi.handlers.get("session_tree")!({ newLeafId: "branch-x" }, ctx);

    // ``before_provider_request`` is the per-request env re-derivation;
    // it must read the active branch leaf, not the bare session id, so the
    // wire keeps the branched conv id across many turns in the same branch.
    const beforeRequest = pi.handlers.get("before_provider_request")!;
    await beforeRequest({ payload: {} }, ctx);

    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234:branch-x");
  });

  it("session_start clears the active branch (fresh pi invocation starts bare)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeBranchCtx("neuralwatt/glm-5.1-long");

    // Take a branch, then re-boot the session (simulates a fresh `pi`
    // invocation on the same session file).
    await pi.handlers.get("session_start")!({}, ctx);
    await pi.handlers.get("session_tree")!({ newLeafId: "branch-x" }, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234:branch-x");

    // Pi rebuilds the agent — session_start fires again. The branch state
    // must reset to bare so the new invocation isn't pinned to a stale leaf.
    // (Use a different session id so we don't trip the double-fire guard.)
    const ctx2 = makeBranchCtx(
      "neuralwatt/glm-5.1-long", { sessionId: "sess-test-9999" },
    );
    await pi.handlers.get("session_start")!({}, ctx2);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-9999");
  });

  it("an empty / undefined leaf id leaves the conv id bare (no trailing colon)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeBranchCtx(
      "neuralwatt/glm-5.1-long", { leafId: null },
    );

    await pi.handlers.get("session_start")!({}, ctx);
    // session_tree event with no newLeafId AND ctx.getLeafId() returning null
    // — the conv id should stay bare. A trailing colon (e.g.
    // ``sess-test-1234:``) would tip the gateway into thinking this is a
    // branch when it isn't.
    await pi.handlers.get("session_tree")!({}, ctx);
    expect(process.env.X_NW_CONVERSATION_ID).toBe("sess-test-1234");
  });

  it("the branched conv id is well-formed and passes server-side validation", async () => {
    // Server-side rule (mirrors mcr_v3_session.validate_client_conversation_id):
    // non-empty, ≤ 256 chars, printable. The extension validates the composed
    // form before substituting so a malformed pi id never bounces off the
    // server as HTTP 400.
    const pi = makeMockPi();
    (await loadExtension())(pi);

    // Realistic-shape ids: 36-char UUID + 8-hex leaf = 45 chars, well under 256.
    const realisticCtx = makeBranchCtx("neuralwatt/glm-5.1-long", {
      sessionId: "019e8e34-e193-7d0c-b5b3-f0dcb5014328",
      leafId: "f10fd666",
    });
    await pi.handlers.get("session_start")!({}, realisticCtx);
    await pi.handlers.get("session_tree")!(
      { newLeafId: "f10fd666" }, realisticCtx,
    );
    const composed = process.env.X_NW_CONVERSATION_ID!;
    expect(composed).toBe(
      "019e8e34-e193-7d0c-b5b3-f0dcb5014328:f10fd666",
    );
    expect(composed.length).toBeLessThan(256);
    // All printable ASCII — no control chars.
    expect(/^[\x20-\x7E]+$/.test(composed)).toBe(true);
  });
});

describe("#44 dual-instance guard", () => {
  // Pi auto-loads ~/.pi/agent/extensions/neuralwatt-mcr.ts in addition to any
  // -e <path> copy, so two copies of the module — each with its own module
  // scope — can be activated in one process. The 2026-06-09 forensics show
  // exactly that (every log event doubled, 2.3.0 + 2.1.1 both live), with two
  // drop-protocol state machines racing one session. First activation wins;
  // the second must register NOTHING and say so loudly.

  it("first activation claims the globalThis sentinel and registers normally", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    expect(pi.providers["neuralwatt"]).toBeTruthy();
    expect(pi.handlers.size).toBeGreaterThan(0);

    const sentinel = (globalThis as Record<string, unknown>)
      .__NEURALWATT_MCR_ACTIVE__ as Record<string, unknown>;
    expect(sentinel).toBeTruthy();
    expect(sentinel.version).toBe("2.5.3");
    expect(typeof sentinel.module).toBe("string");
    expect(typeof sentinel.ts).toBe("string");
    // 2.5.1: the claim carries an activation id (ownership for touch/release)
    // and a heartbeat (staleness detection).
    expect(typeof sentinel.activationId).toBe("string");
    expect(typeof sentinel.heartbeatTs).toBe("number");

    // The wire-visible version (X-NW-MCR-Ext-Version env seed) matches the
    // bump, so prod can verify the rollout.
    expect(process.env.X_NW_MCR_EXT_VERSION).toBe("2.5.3");
  });

  it("second activation in the same process registers NOTHING and logs dual_instance_blocked", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    const pi2 = makeMockPi();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ext(pi1);
      expect(pi1.providers["neuralwatt"]).toBeTruthy();
      expect(pi1.handlers.size).toBeGreaterThan(0);

      ext(pi2);
      // No HTTP hooks, no handlers, no provider, no tools — nothing at all.
      expect(Object.keys(pi2.providers)).toHaveLength(0);
      expect(pi2.handlers.size).toBe(0);
      expect(Object.keys(pi2.tools)).toHaveLength(0);

      // Loud in the extension log…
      const blockedLine = readLog()
        .split("\n")
        .find((l) => l.includes("dual_instance_blocked"));
      expect(blockedLine).toBeTruthy();
      const blocked = JSON.parse(blockedLine!);
      expect(blocked.winner.version).toBe("2.5.3");
      expect(blocked.loser.version).toBe("2.5.3");

      // …and on stderr (visible interactively).
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0][0])).toContain(
        "DUAL INSTANCE BLOCKED",
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it("fail-open: a sealed sentinel slot never blocks activation", async () => {
    // Simulate a hostile/frozen global: the sentinel slot exists but cannot
    // be written (strict-mode write throws). Activation must still register
    // everything — a doubly-registered extension is the known-bad state we
    // survived; a never-registered one is strictly worse — and log the
    // anomaly.
    Object.defineProperty(globalThis, "__NEURALWATT_MCR_ACTIVE__", {
      value: undefined,
      writable: false,
      configurable: true, // so the afterEach cleanup can remove it
    });

    const pi = makeMockPi();
    (await loadExtension())(pi);

    expect(pi.providers["neuralwatt"]).toBeTruthy();
    expect(pi.handlers.size).toBeGreaterThan(0);
    expect(readLog()).toContain("dual_instance_guard_anomaly");
  });
});

describe("2.5.1 dual-instance guard: stale-sentinel release (Nico false positive)", () => {
  // Pi re-runs every extension factory IN-PROCESS on /new, /resume, fork and
  // /reload (AgentSessionRuntime.teardownCurrent / AgentSession.reload →
  // resourceLoader.reload() → loadExtensions; jiti moduleCache:false). The
  // 2.5.0 sentinel was never cleared, so every such re-activation was blocked
  // as a "dual instance" while pi had already discarded the prior
  // activation's handlers — leaving ZERO registered copies (MCR + provider
  // silently off). The fix releases the claim on session_shutdown and, as a
  // backup, lets a claimant steal a sentinel whose heartbeat has gone stale.

  function sentinel(): Record<string, unknown> {
    return (globalThis as Record<string, unknown>)
      .__NEURALWATT_MCR_ACTIVE__ as Record<string, unknown>;
  }

  it("session_shutdown releases the claim so the next activation registers (pi /new, /resume, fork, /reload)", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    ext(pi1);
    expect(sentinel()).toBeTruthy();

    // Pi emits session_shutdown to the old runner before every teardown
    // that precedes an in-process re-load.
    await pi1.handlers.get("session_shutdown")!(
      { reason: "new" },
      makeCtx("neuralwatt/glm-5.1-long"),
    );
    expect(sentinel()).toBeUndefined();

    // The re-activation (fresh load pass) must register everything.
    const pi2 = makeMockPi();
    ext(pi2);
    expect(pi2.providers["neuralwatt"]).toBeTruthy();
    expect(pi2.handlers.size).toBeGreaterThan(0);
    expect(readLog()).not.toContain("dual_instance_blocked");
  });

  it("a claimant steals a sentinel whose heartbeat went stale and logs dual_instance_steal_stale", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    ext(pi1);
    const firstActivationId = sentinel().activationId;

    // Simulate a prior activation pi tore down WITHOUT emitting
    // session_shutdown (e.g. SDK hosts calling resourceLoader.reload()
    // directly): the claim is still there but its heartbeat has gone stale.
    sentinel().heartbeatTs = Date.now() - 31_000;

    const pi2 = makeMockPi();
    ext(pi2);
    // The new activation registered normally…
    expect(pi2.providers["neuralwatt"]).toBeTruthy();
    expect(pi2.handlers.size).toBeGreaterThan(0);
    // …took over the claim under a new activation id with a fresh heartbeat…
    expect(sentinel().activationId).not.toBe(firstActivationId);
    expect(Date.now() - (sentinel().heartbeatTs as number)).toBeLessThan(
      1_000,
    );
    // …and the steal is logged distinctly (NOT as a block).
    const stealLine = readLog()
      .split("\n")
      .find((l) => l.includes("dual_instance_steal_stale"));
    expect(stealLine).toBeTruthy();
    const steal = JSON.parse(stealLine!);
    expect(steal.prior.heartbeat_age_ms).toBeGreaterThan(30_000);
    expect(steal.claimant.version).toBe("2.5.3");
    expect(readLog()).not.toContain("dual_instance_blocked");
  });

  it("a FRESH heartbeat still blocks — true dual-load (auto-load + -e) stays dead", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    const pi2 = makeMockPi();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ext(pi1);
      // Two copies in one load pass activate within milliseconds — the
      // second always sees a fresh heartbeat and must register NOTHING.
      ext(pi2);
      expect(Object.keys(pi2.providers)).toHaveLength(0);
      expect(pi2.handlers.size).toBe(0);
      expect(readLog()).toContain("dual_instance_blocked");
      expect(readLog()).not.toContain("dual_instance_steal_stale");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the winner's heartbeat refreshes on every event it handles", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    // Age the heartbeat, then drive a handled event (any model — the touch
    // happens before the isMCRModel guard). The heartbeat must come back
    // fresh, so an ACTIVE copy can never be mistaken for a stale one.
    sentinel().heartbeatTs = 1;
    await pi.handlers.get("context")!(
      { messages: [{ type: "user" }] },
      makeCtx("deepseek-v4-pro"),
    );
    expect(Date.now() - (sentinel().heartbeatTs as number)).toBeLessThan(
      1_000,
    );

    // before_provider_request — the per-request hook — touches too.
    sentinel().heartbeatTs = 1;
    await pi.handlers.get("before_provider_request")!(
      { payload: {} },
      makeCtx("deepseek-v4-pro"),
    );
    expect(Date.now() - (sentinel().heartbeatTs as number)).toBeLessThan(
      1_000,
    );
  });

  it("a superseded activation's late session_shutdown cannot release the new holder's claim", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    ext(pi1);
    sentinel().heartbeatTs = Date.now() - 31_000;
    const pi2 = makeMockPi();
    ext(pi2); // steals
    const holderActivationId = sentinel().activationId;

    // The old runner's shutdown fires late — ownership check must no-op.
    await pi1.handlers.get("session_shutdown")!(
      { reason: "new" },
      makeCtx("neuralwatt/glm-5.1-long"),
    );
    expect(sentinel()).toBeTruthy();
    expect(sentinel().activationId).toBe(holderActivationId);
  });

  it("a legacy (≤2.5.0) sentinel without a heartbeat is never stolen", async () => {
    // A 2.5.0 winner never refreshes a heartbeat, so staleness cannot be
    // distinguished from liveness — and a mixed-version install is exactly
    // the tools#44 dual-load. Block, as before.
    (globalThis as Record<string, unknown>).__NEURALWATT_MCR_ACTIVE__ = {
      version: "2.5.0",
      module: "file:///legacy/neuralwatt-mcr.ts",
      ts: new Date(Date.now() - 3_600_000).toISOString(),
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pi = makeMockPi();
      (await loadExtension())(pi);
      expect(Object.keys(pi.providers)).toHaveLength(0);
      expect(pi.handlers.size).toBe(0);
      expect(readLog()).toContain("dual_instance_blocked");
      expect(readLog()).not.toContain("dual_instance_steal_stale");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("the blocked-copy stderr message carries the false-positive guidance", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    const pi2 = makeMockPi();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ext(pi1);
      ext(pi2);
      const msg = String(errSpy.mock.calls[0][0]);
      expect(msg).toContain("DUAL INSTANCE BLOCKED");
      expect(msg).toContain("If the paths are identical");
      expect(msg).toContain("should self-resolve");
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("#44 post-drop stale-window self-heal", () => {
  // Forensics 2026-06-09: after honoring a server context-drop, the
  // extension's outbound window froze at a 114-message snapshot for 35-40
  // minute stretches while 575+ new local turns never went out; the
  // server-side breaker fired ~24k times into the stale window with zero
  // effect. The invariant detects "window signature identical to the previous
  // request WHILE local history grew" and, after N=2 consecutive triggers,
  // resets the drop bookkeeping and sends the FULL history.

  function makeMCRCtx(sessionId: string) {
    return {
      model: { id: "neuralwatt/glm-5.1-long" },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
      ui: { setStatus: () => {} },
    };
  }

  // History shape: 3 user anchors early, then identical tool turns appended at
  // the tail. These tests call session_start, so a well-formed conv-id is on
  // the wire and (since 2.5.2) the drop honors safe_drop_before directly with
  // dropStart = 0 — the anchor floor no longer applies. So `mkMsgs(n)` with
  // safe_drop_before = s yields a window of n - s messages (indices [s, n)).
  // Identical tail messages let a test freeze the window SIGNATURE (length +
  // last-msg role/content-length) while the history grows, by moving
  // safe_drop_before in lock-step — the simulated equivalent of whatever
  // swallowed the new turns in prod. The stale-window invariant under test is
  // orthogonal to where dropStart begins.
  function mkMsgs(n: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
      { type: "user", content: "u1" },
      { type: "assistant", content: "a1" },
      { type: "user", content: "u2" },
      { type: "assistant", content: "a2" },
      { type: "user", content: "u3" },
      { type: "assistant", content: "a3" },
    ];
    while (msgs.length < n) msgs.push({ type: "tool", content: "tool-result" });
    return msgs;
  }

  // Drive the server side of the drop handshake: the gateway confirms it
  // persisted history (stored_through) and authorizes the client to drop
  // everything before safe_drop_before.
  async function serverConfirm(
    pi: MockPi,
    ctx: unknown,
    safeDropBefore: number,
  ) {
    await pi.handlers.get("after_provider_response")!(
      {
        headers: {
          "x-mcr-session-fp": "fp-test-4444",
          "x-mcr-safe-drop-before": String(safeDropBefore),
          "x-mcr-stored-through": String(safeDropBefore),
        },
      },
      ctx,
    );
  }

  it("self-heals after N consecutive frozen-window requests while local history grows", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-heal-1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await pi.handlers.get("session_start")!({}, ctx);
      const context = pi.handlers.get("context")!;

      // Turn 1: server authorizes drop<8; window built normally (baseline).
      // conv-id mode -> drop range [0, 8) -> 2 of 10 messages go out.
      await serverConfirm(pi, ctx, 8);
      const r1 = await context({ messages: mkMsgs(10) }, ctx);
      expect(r1.messages).toHaveLength(2);

      // Turn 2: local history grew (11 msgs) but the outgoing window is
      // shape-identical (same length, same tail) — trigger 1 of 2. Still
      // drops normally.
      await serverConfirm(pi, ctx, 9);
      const r2 = await context({ messages: mkMsgs(11) }, ctx);
      expect(r2.messages).toHaveLength(2);
      expect(readLog()).not.toContain("stale_window_self_heal");

      // Turn 3: frozen again while local grew — trigger 2 = N. SELF-HEAL:
      // no message mutation (the FULL 12-message history goes out), loud log
      // event + console.error.
      await serverConfirm(pi, ctx, 10);
      const r3 = await context({ messages: mkMsgs(12) }, ctx);
      expect(r3).toBeUndefined();

      const healLine = readLog()
        .split("\n")
        .find((l) => l.includes("stale_window_self_heal"));
      expect(healLine).toBeTruthy();
      const heal = JSON.parse(healLine!);
      expect(heal.repeats).toBe(2);
      expect(heal.window_len).toBe(2);
      expect(heal.local_len).toBe(12);
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0][0])).toContain(
        "STALE WINDOW SELF-HEAL",
      );

      // Post-heal: drop bookkeeping was reset, so the next request also
      // sends the full history (safe_drop_before is back to 0)…
      const r4 = await context({ messages: mkMsgs(13) }, ctx);
      expect(r4).toBeUndefined();
      const log = readLog();
      expect(log).toContain("safe_drop_before_zero");
      // …and the heal does NOT loop: still exactly one heal event.
      expect(log.match(/stale_window_self_heal/g)).toHaveLength(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("false-positive safety: a pure retry (identical window, NO local growth) never triggers", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-retry-1");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;
    await serverConfirm(pi, ctx, 8);

    // The same 10-message history sent 4 times (e.g. network retries): the
    // window signature is identical every time but the local history has NOT
    // grown, so the two-sided trigger stays false and the drop keeps
    // applying. conv-id mode -> drop [0, 8) -> 2 of 10 go out each time.
    for (let i = 0; i < 4; i++) {
      const r = await context({ messages: mkMsgs(10) }, ctx);
      expect(r.messages).toHaveLength(2);
    }
    expect(readLog()).not.toContain("stale_window_self_heal");
  });

  it("false-positive safety: a normally advancing window never triggers", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-adv-1");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;
    await serverConfirm(pi, ctx, 8);

    // safe_drop_before stays fixed while the history grows — the healthy
    // shape: the window's tail carries each new local turn, so the signature
    // advances every request and the streak never starts. conv-id mode drops
    // [0, 8) -> the window is n - 8 messages and grows with n.
    for (let n = 10; n <= 14; n++) {
      const r = await context({ messages: mkMsgs(n) }, ctx);
      expect(r.messages).toHaveLength(n - 8); // fixed drop<8, window grows with n
    }
    expect(readLog()).not.toContain("stale_window_self_heal");
  });

  it("a single frozen request followed by an advancing one resets the streak", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-streak-1");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;

    // Baseline (10 msgs, drop<8 -> 2 out), then ONE frozen-while-growing
    // request (trigger 1 of 2)…
    await serverConfirm(pi, ctx, 8);
    await context({ messages: mkMsgs(10) }, ctx);
    await serverConfirm(pi, ctx, 9);
    const r2 = await context({ messages: mkMsgs(11) }, ctx);
    expect(r2.messages).toHaveLength(2);

    // …then the window ADVANCES (same drop<9, history grows -> 3 out): the
    // consecutive-trigger streak must reset…
    const r3 = await context({ messages: mkMsgs(12) }, ctx);
    expect(r3.messages).toHaveLength(3);

    // …so a later single frozen request is trigger 1 again, not 2 — no heal.
    await serverConfirm(pi, ctx, 10);
    const r4 = await context({ messages: mkMsgs(13) }, ctx);
    expect(r4.messages).toHaveLength(3);
    expect(readLog()).not.toContain("stale_window_self_heal");
  });
});

describe("2.5.2 conv-id mode honors safe_drop_before below the anchor floor", () => {
  // Tom 2026-06-11, prod session 2d876919, ext 2.5.1: a codebase-audit-from-
  // ONE-prompt session (1 user message + hundreds of assistant/tool turns)
  // never dropped. The content-anchor floor (`findAnchorFloor` for the 3rd
  // user message) returned -1 with <3 user messages, so `computeDropRange`
  // returned an empty range and the extension emitted
  // `context_no_drop reason=empty_range` every turn while the server's
  // safe_drop_before climbed — the client re-sent the full ever-growing
  // history forever (APC collapse, runaway cost). The floor is only needed
  // for the server's content-anchor identity fallback (no conversation id);
  // when a conv-id IS on the wire the server keys identity on it, so the
  // floor must not block dropping.

  function makeMCRCtx(sessionId: string) {
    return {
      model: { id: "neuralwatt/glm-5.1-long" },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
      ui: { setStatus: () => {} },
    };
  }

  // The server side of the drop handshake: confirm persisted history and
  // authorize dropping everything before safeDropBefore.
  async function serverConfirm(pi: MockPi, ctx: unknown, safeDropBefore: number) {
    await pi.handlers.get("after_provider_response")!(
      {
        headers: {
          "x-mcr-session-fp": "fp-test-2d87",
          "x-mcr-safe-drop-before": String(safeDropBefore),
          "x-mcr-stored-through": String(safeDropBefore),
        },
      },
      ctx,
    );
  }

  // Single-user-prompt agentic session: ONE user message, then n-1 mixed
  // assistant/tool turns. This is the exact shape that hit anchorIdx === -1.
  function mkSinglePrompt(n: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
      { type: "user", content: "audit the whole codebase and fix the bugs" },
    ];
    let i = 0;
    while (msgs.length < n) {
      msgs.push(
        i % 2 === 0
          ? { type: "assistant", content: `step ${i}` }
          : { type: "tool", content: `tool-result ${i}` },
      );
      i++;
    }
    return msgs;
  }

  // A session with >= 3 user messages (the content-anchor floor is satisfied).
  function mkMultiPrompt(n: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
      { type: "user", content: "u1" },
      { type: "assistant", content: "a1" },
      { type: "user", content: "u2" },
      { type: "assistant", content: "a2" },
      { type: "user", content: "u3" },
      { type: "assistant", content: "a3" },
    ];
    let i = 0;
    while (msgs.length < n) {
      msgs.push({ type: "tool", content: `tool-result ${i++}` });
    }
    return msgs;
  }

  it("conv-id active + <3 user messages: drops [0, safeDrop), preserves the tail", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-single-1");
    // session_start upgrades X_NW_CONVERSATION_ID to the stable session id —
    // a well-formed conv-id is now on the wire, so the anchor floor lifts.
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;

    await serverConfirm(pi, ctx, 5);
    // 12 messages, 1 user message. Pre-fix this returned [0,0] (empty_range).
    const r = await context({ messages: mkSinglePrompt(12) }, ctx);

    // Drops the reconstructible prefix [0, 5): 5 messages gone, tail (>=5)
    // intact -> 7 messages go out.
    expect(r.messages).toHaveLength(7);
    // The recent tail the server reserved (indices >= safeDropBefore) is never
    // touched: the LAST local message is still present at the tail.
    const sent = r.messages as Array<{ content?: unknown }>;
    expect(sent[sent.length - 1].content).toBe("step 10");

    // Distinct telemetry confirms a single-prompt drop happened.
    const dropLine = readLog()
      .split("\n")
      .find((l) => l.includes('"context_drop"'));
    expect(dropLine).toBeTruthy();
    const drop = JSON.parse(dropLine!);
    expect(drop.reason).toBe("convid_no_anchor");
    expect(drop.drop_start).toBe(0);
    expect(drop.drop_end).toBe(5);
    expect(drop.conv_id_active).toBe(true);
    expect(drop.user_msgs).toBe(1);
    // The bug signature must NOT appear.
    expect(readLog()).not.toContain("empty_range");
  });

  it("NO conv-id + <3 user messages: still drops nothing (content-anchor fallback intact)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-single-2");
    const context = pi.handlers.get("context")!;

    // Simulate the content-anchor fallback: NO conversation id on the wire.
    // Do NOT call session_start (which would set the env var); clear the
    // boot-seeded UUID so conversationIdActive() is false.
    delete process.env.X_NW_CONVERSATION_ID;

    await serverConfirm(pi, ctx, 5);
    const r = await context({ messages: mkSinglePrompt(12) }, ctx);

    // Fallback protection holds: fewer than 3 user messages -> drop nothing.
    expect(r).toBeUndefined();
    const noDropLine = readLog()
      .split("\n")
      .find((l) => l.includes('"context_no_drop"'));
    expect(noDropLine).toBeTruthy();
    const noDrop = JSON.parse(noDropLine!);
    expect(noDrop.reason).toBe("empty_range");
    expect(noDrop.conv_id_active).toBe(false);
    expect(noDrop.user_msgs).toBe(1);
  });

  it(">=3 user messages, conv-id mode: drops from 0, tail preserved", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-multi-convid");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;

    await serverConfirm(pi, ctx, 5);
    const r = await context({ messages: mkMultiPrompt(12) }, ctx);
    // [0, 5) dropped -> 7 out; tail (indices >= 5) intact.
    expect(r.messages).toHaveLength(7);
    const drop = JSON.parse(
      readLog().split("\n").find((l) => l.includes('"context_drop"'))!,
    );
    expect(drop.drop_start).toBe(0);
    expect(drop.drop_end).toBe(5);
    expect(drop.reason).toBe("convid"); // at/above the floor
    expect(drop.user_msgs).toBe(3);
  });

  it(">=3 user messages, NO conv-id: unchanged legacy fallback (preserve first 3 user msgs)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-multi-fallback");
    const context = pi.handlers.get("context")!;
    // No conversation id on the wire -> content-anchor fallback.
    delete process.env.X_NW_CONVERSATION_ID;

    // 3rd user message is at index 4, so legacy dropStart = 5. Use a
    // safeDropBefore beyond that so the range is non-empty.
    await serverConfirm(pi, ctx, 8);
    const r = await context({ messages: mkMultiPrompt(12) }, ctx);
    // [5, 8) dropped -> 9 out; the 3 user anchors (indices 0,2,4) survive.
    expect(r.messages).toHaveLength(9);
    const sent = r.messages as Array<{ content?: unknown }>;
    expect(sent.slice(0, 5).map((m) => m.content)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
    ]);
    const drop = JSON.parse(
      readLog().split("\n").find((l) => l.includes('"context_drop"'))!,
    );
    expect(drop.drop_start).toBe(5);
    expect(drop.reason).toBe("content_anchor");
    expect(drop.conv_id_active).toBe(false);
  });

  it("conv-id mode never drops messages at/after safe_drop_before (reserved tail)", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-tail-1");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;

    // safeDropBefore = 9 on a 20-message single-prompt session: indices
    // [0,9) drop, [9,20) (11 messages) are the reserved tail and must remain.
    await serverConfirm(pi, ctx, 9);
    const msgs = mkSinglePrompt(20);
    const reservedTail = msgs.slice(9); // the messages that must survive
    const r = await context({ messages: msgs }, ctx);

    expect(r.messages).toHaveLength(11);
    // Every reserved-tail message is present, in order, untouched.
    expect((r.messages as Array<unknown>)).toEqual(reservedTail);
  });
});

describe("2.5.3 keeps honoring safe_drop_before across a session branch", () => {
  // Regression: Tom 2026-06-14, ext 2.5.2. A pi BRANCH (session_shutdown then a
  // module re-eval under jiti, then session_start with reason "fork"/"resume"/
  // "reload") recreates the module-scoped `state` with sessionFp=null /
  // safeDropBefore=0. The conv-id (= pi session id) PERSISTS across the re-eval,
  // so the gateway keeps the same session_fp and keeps emitting
  // safe_drop_before — but the freshly-wiped client hit `if (!state.sessionFp)
  // return` (`context_skip no_session_fp`) and NEVER pruned, so the window ran
  // away (1.36M client-window tokens, server safe_drop_before=615 ignored,
  // repeating `session_shutdown final_session_fp=null`). A fresh non-branched
  // session dropped fine; pi-vcc / dual-instance stacking was ruled out by repro.
  // Fix: stash the drop high-water on globalThis (survives the jiti re-eval)
  // keyed by the persistent conv-id and restore it when the conv-id matches.

  function makeMCRCtx(sessionId: string) {
    return {
      model: { id: "neuralwatt/glm-5.1-long" },
      sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
      ui: { setStatus: () => {} },
    };
  }

  async function serverConfirm(
    pi: MockPi,
    ctx: unknown,
    safeDropBefore: number,
    fp = "fp-branch-2d87",
  ) {
    await pi.handlers.get("after_provider_response")!(
      {
        headers: {
          "x-mcr-session-fp": fp,
          "x-mcr-safe-drop-before": String(safeDropBefore),
          "x-mcr-stored-through": String(safeDropBefore),
        },
      },
      ctx,
    );
  }

  // Single-user-prompt agentic session (1 user msg + mixed assistant/tool
  // turns) — the runaway shape. conv-id mode drops [0, safeDropBefore).
  function mkSinglePrompt(n: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
      { type: "user", content: "audit the whole codebase" },
    ];
    let i = 0;
    while (msgs.length < n) {
      msgs.push(
        i % 2 === 0
          ? { type: "assistant", content: `step ${i}` }
          : { type: "tool", content: `tool-result ${i}` },
      );
      i++;
    }
    return msgs;
  }

  // Identical-tail history (1 user anchor + repeated identical tool turns). In
  // conv-id mode the drop is [0, s), so the outgoing window is msgs[s..n): with
  // s and n moving in lockstep the window length AND last-message identity stay
  // fixed → the signature freezes while local history grows (the stale-window
  // trigger). mkSinglePrompt's per-index content would change the tail and so
  // never freeze.
  function mkIdenticalTail(n: number): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [
      { type: "user", content: "u1" },
    ];
    while (msgs.length < n) msgs.push({ type: "tool", content: "tool-result" });
    return msgs;
  }

  function dropCache(): Record<string, unknown> {
    return (globalThis as Record<string, unknown>)
      .__NEURALWATT_MCR_DROP_STATE_V1__ as Record<string, unknown>;
  }

  it("a branch (session_start fires, conv-id persists) still computes a non-empty drop on the next turn", async () => {
    const ext = await loadExtension();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pi1 = makeMockPi();
      ext(pi1);
      const ctx = makeMCRCtx("sess-branch-1");

      // Boot + establish the server drop high-water; after_provider_response
      // caches it under the conv-id (= "sess-branch-1").
      await pi1.handlers.get("session_start")!({ reason: "startup" }, ctx);
      await serverConfirm(pi1, ctx, 5);
      expect(dropCache()["sess-branch-1"]).toMatchObject({
        sessionFp: "fp-branch-2d87",
        safeDropBefore: 5,
      });

      // Baseline: the drop applies normally (12 msgs, drop [0,5) -> 7 out).
      const r0 = await pi1.handlers.get("context")!(
        { messages: mkSinglePrompt(12) },
        ctx,
      );
      expect(r0.messages).toHaveLength(7);

      // ── BRANCH ──: pi tears the runner down and re-evaluates the module
      // (fresh state, sessionFp=null), then re-activates and fires session_start
      // with a branch reason. The conv-id is UNCHANGED (same pi session id).
      await pi1.handlers.get("session_shutdown")!({ reason: "fork" }, ctx);
      const pi2 = makeMockPi();
      ext(pi2); // re-activation registers cleanly (sentinel was released)
      expect(pi2.handlers.size).toBeGreaterThan(0);
      await pi2.handlers.get("session_start")!({ reason: "fork" }, ctx);

      // The fp self-healed from the cache at session_start.
      const restoreLine = readLog()
        .split("\n")
        .find((l) => l.includes("drop_state_restored"));
      expect(restoreLine).toBeTruthy();
      const restored = JSON.parse(restoreLine!);
      expect(restored.source).toBe("session_start");
      expect(restored.reason).toBe("fork");
      expect(restored.session_fp).toBe("fp-branch-2d87");
      expect(restored.safe_drop_before).toBe(5);

      // CRUCIAL: the very next context STILL drops — it did NOT get stuck in the
      // no_session_fp skip that caused Tom's runaway. 13 msgs, drop [0,5) -> 8.
      const r1 = await pi2.handlers.get("context")!(
        { messages: mkSinglePrompt(13) },
        ctx,
      );
      expect(r1).not.toBeUndefined();
      expect(r1.messages).toHaveLength(8);
      // The bug signature is absent across the whole branched flow.
      expect(readLog()).not.toContain("no_session_fp");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("a genuinely new conversation after a branch resets cleanly (no cross-conversation restore)", async () => {
    const ext = await loadExtension();
    const pi1 = makeMockPi();
    ext(pi1);
    const ctxA = makeMCRCtx("sess-A");
    await pi1.handlers.get("session_start")!({ reason: "startup" }, ctxA);
    await serverConfirm(pi1, ctxA, 5); // caches sess-A's high-water

    // Teardown, then a brand-NEW session with a DIFFERENT id (e.g. /new).
    await pi1.handlers.get("session_shutdown")!({ reason: "new" }, ctxA);
    const pi2 = makeMockPi();
    ext(pi2);
    const ctxB = makeMCRCtx("sess-B-fresh");
    await pi2.handlers.get("session_start")!({ reason: "new" }, ctxB);

    // No cache entry for the new conv-id → NO restore at session_start.
    expect(readLog()).not.toContain("drop_state_restored");

    // First turn of the new conversation legitimately has no fp → skip (the
    // correct clean-reset behaviour, NOT the runaway).
    const r = await pi2.handlers.get("context")!(
      { messages: mkSinglePrompt(12) },
      ctxB,
    );
    expect(r).toBeUndefined();
    expect(readLog()).toContain("no_session_fp");
  });

  it("the context backstop restores the fp when session_start did not (request-path self-heal)", async () => {
    const ext = await loadExtension();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pi = makeMockPi();
      ext(pi);

      // Seed a cached high-water for a conversation, as a prior activation's
      // after_provider_response would have.
      (globalThis as Record<string, unknown>).__NEURALWATT_MCR_DROP_STATE_V1__ = {
        "sess-ctx-heal": {
          sessionFp: "fp-cached-77",
          safeDropBefore: 5,
          storedThrough: 5,
          ts: Date.now(),
        },
      };

      // Boot an UNRELATED session so state.sessionFp is reset to null with no
      // restore (no cache entry for "sess-unrelated").
      const otherCtx = makeMCRCtx("sess-unrelated");
      await pi.handlers.get("session_start")!({ reason: "startup" }, otherCtx);
      expect(readLog()).not.toContain("drop_state_restored");

      // Now the wire conv-id points at the cached conversation (a resume that
      // re-derived this id) while state.sessionFp is still null. The context
      // handler must restore from the cache and drop, NOT skip no_session_fp.
      process.env.X_NW_CONVERSATION_ID = "sess-ctx-heal";
      const r = await pi.handlers.get("context")!(
        { messages: mkSinglePrompt(12) },
        otherCtx,
      );
      expect(r).not.toBeUndefined();
      expect(r.messages).toHaveLength(7); // [0,5) dropped
      const restoreLine = readLog()
        .split("\n")
        .find((l) => l.includes("drop_state_restored"));
      expect(restoreLine).toBeTruthy();
      expect(JSON.parse(restoreLine!).source).toBe("context");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("an expired (>TTL) cached high-water is not restored", async () => {
    const ext = await loadExtension();
    const pi = makeMockPi();
    ext(pi);
    // A day-and-change-old entry: the conversation is treated as ended.
    (globalThis as Record<string, unknown>).__NEURALWATT_MCR_DROP_STATE_V1__ = {
      "sess-stale": {
        sessionFp: "fp-old",
        safeDropBefore: 5,
        storedThrough: 5,
        ts: Date.now() - (24 * 60 * 60 * 1000 + 60_000),
      },
    };
    const ctx = makeMCRCtx("sess-stale");
    await pi.handlers.get("session_start")!({ reason: "resume" }, ctx);
    // Expired → no restore; the first response will re-establish the fp.
    expect(readLog()).not.toContain("drop_state_restored");
    const r = await pi.handlers.get("context")!(
      { messages: mkSinglePrompt(12) },
      ctx,
    );
    expect(r).toBeUndefined();
    expect(readLog()).toContain("no_session_fp");
  });

  it("the stale-window self-heal clears the cached high-water so a later reload can't re-freeze", async () => {
    const ext = await loadExtension();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const pi = makeMockPi();
      ext(pi);
      const ctx = makeMCRCtx("sess-heal-cache");
      await pi.handlers.get("session_start")!({ reason: "startup" }, ctx);
      const context = pi.handlers.get("context")!;

      // Drive the stale-window invariant to a heal (window frozen while local
      // history grows for N=2 consecutive requests — identical tail, s and n in
      // lockstep so the window length and last message stay fixed).
      await serverConfirm(pi, ctx, 8);
      await context({ messages: mkIdenticalTail(10) }, ctx);
      expect(dropCache()["sess-heal-cache"]).toBeTruthy();
      await serverConfirm(pi, ctx, 9);
      await context({ messages: mkIdenticalTail(11) }, ctx);
      await serverConfirm(pi, ctx, 10);
      const healed = await context({ messages: mkIdenticalTail(12) }, ctx);

      expect(healed).toBeUndefined(); // full history sent
      expect(readLog()).toContain("stale_window_self_heal");
      // The cached high-water was dropped so a subsequent reload won't restore
      // the pre-heal safe_drop_before and re-freeze the window.
      expect(dropCache()["sess-heal-cache"]).toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("mcr_lookup placeholder stub (inference_frontend#4039)", () => {
  // On mixed agentic turns the gateway forwards the model's server-side
  // `mcr_lookup` tool call to the client by design; the gateway replaces the
  // client's placeholder tool_result with the real content on the NEXT
  // request (cross-turn injection). The stub exists only so pi stops
  // rendering "Tool mcr_lookup not found" — it must return a stable
  // placeholder and must NEVER resolve the hash itself (client protocol
  // forbids client-side resolution).
  const PLACEHOLDER =
    "[recall delegated to server — content is injected by the gateway on the next turn]";

  it("registers an mcr_lookup tool with a required string `hash` param", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const tool = pi.tools["mcr_lookup"];
    expect(tool).toBeTruthy();
    expect(tool.label).toBe("MCR server-side recall");
    // Single required string param named `hash`, matching the gateway's tool
    // definition so the forwarded call passes client-side validation.
    expect(tool.parameters.required).toEqual(["hash"]);
    expect(tool.parameters.properties.hash.type).toBe("string");
    // Extra params from a future gateway revision must NOT fail validation.
    expect(tool.parameters.additionalProperties).not.toBe(false);
  });

  it("execute returns the neutral placeholder and does not resolve the hash", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const tool = pi.tools["mcr_lookup"];
    const result = await tool.execute("call_1", { hash: "abc123def456" });

    // PLACEHOLDER ONLY — the gateway overwrites it via cross-turn injection.
    expect(result.content).toEqual([{ type: "text", text: PLACEHOLDER }]);
    expect(result.details).toEqual({ hash: "abc123def456", placeholder: true });

    // Observable in the extension log for forensics.
    const line = readLog()
      .split("\n")
      .find((l) => l.includes("mcr_lookup_stub"));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!).hash_prefix).toBe("abc123def456".slice(0, 12));
  });

  it("prepareArguments coerces a missing/non-string hash and drops extra params", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);

    const tool = pi.tools["mcr_lookup"];
    // Extra params are ignored, hash passes through.
    expect(tool.prepareArguments({ hash: "h1", surprise: 42 })).toEqual({
      hash: "h1",
    });
    // Defensive coercions — never let client-side validation reject a call
    // the gateway will resolve anyway.
    expect(tool.prepareArguments({})).toEqual({ hash: "" });
    expect(tool.prepareArguments(undefined)).toEqual({ hash: "" });
    expect(tool.prepareArguments({ hash: 123 })).toEqual({ hash: "123" });
  });
});

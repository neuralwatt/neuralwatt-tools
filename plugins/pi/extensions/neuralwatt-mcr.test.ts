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
  on: (event: string, handler: Handler) => void;
  registerProvider: (name: string, config: any) => void;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler>();
  const providers: Record<string, any> = {};
  return {
    handlers,
    providers,
    on(event, handler) {
      // The extension registers some events more than once across refactors;
      // last-registration-wins mirrors how Pi's runner would dispatch the
      // final handler for a given event in this single module.
      handlers.set(event, handler);
    },
    registerProvider(name, config) {
      providers[name] = config;
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

beforeEach(() => {
  // Reset the env-var seeds and the log between tests. Re-seed the conversation
  // id the same way the extension does at module load (it only seeds once).
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  clearDualInstanceSentinel();
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
    expect(sentinel.version).toBe("2.4.0");
    expect(typeof sentinel.module).toBe("string");
    expect(typeof sentinel.ts).toBe("string");

    // The wire-visible version (X-NW-MCR-Ext-Version env seed) matches the
    // bump, so prod can verify the rollout.
    expect(process.env.X_NW_MCR_EXT_VERSION).toBe("2.4.0");
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
      // No HTTP hooks, no handlers, no provider — nothing at all.
      expect(Object.keys(pi2.providers)).toHaveLength(0);
      expect(pi2.handlers.size).toBe(0);

      // Loud in the extension log…
      const blockedLine = readLog()
        .split("\n")
        .find((l) => l.includes("dual_instance_blocked"));
      expect(blockedLine).toBeTruthy();
      const blocked = JSON.parse(blockedLine!);
      expect(blocked.winner.version).toBe("2.4.0");
      expect(blocked.loser.version).toBe("2.4.0");

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

  // History shape: 3 user anchors early (anchor floor = index 4, so
  // dropStart = 5), then identical tool turns appended at the tail. Identical
  // tail messages let a test freeze the window SIGNATURE (length + last-msg
  // role/content-length) while the history grows, by moving safe_drop_before
  // in lock-step — the simulated equivalent of whatever swallowed the new
  // turns in prod.
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
      // drop range [5, 8) -> 7 of 10 messages go out.
      await serverConfirm(pi, ctx, 8);
      const r1 = await context({ messages: mkMsgs(10) }, ctx);
      expect(r1.messages).toHaveLength(7);

      // Turn 2: local history grew (11 msgs) but the outgoing window is
      // shape-identical (same length, same tail) — trigger 1 of 2. Still
      // drops normally.
      await serverConfirm(pi, ctx, 9);
      const r2 = await context({ messages: mkMsgs(11) }, ctx);
      expect(r2.messages).toHaveLength(7);
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
      expect(heal.window_len).toBe(7);
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
    // applying.
    for (let i = 0; i < 4; i++) {
      const r = await context({ messages: mkMsgs(10) }, ctx);
      expect(r.messages).toHaveLength(7);
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
    // advances every request and the streak never starts.
    for (let n = 10; n <= 14; n++) {
      const r = await context({ messages: mkMsgs(n) }, ctx);
      expect(r.messages).toHaveLength(n - 3); // fixed 3-message drop range
    }
    expect(readLog()).not.toContain("stale_window_self_heal");
  });

  it("a single frozen request followed by an advancing one resets the streak", async () => {
    const pi = makeMockPi();
    (await loadExtension())(pi);
    const ctx = makeMCRCtx("sess-streak-1");
    await pi.handlers.get("session_start")!({}, ctx);
    const context = pi.handlers.get("context")!;

    // Baseline (10 msgs, drop<8 -> 7 out), then ONE frozen-while-growing
    // request (trigger 1 of 2)…
    await serverConfirm(pi, ctx, 8);
    await context({ messages: mkMsgs(10) }, ctx);
    await serverConfirm(pi, ctx, 9);
    const r2 = await context({ messages: mkMsgs(11) }, ctx);
    expect(r2.messages).toHaveLength(7);

    // …then the window ADVANCES (same drop<9, history grows -> 8 out): the
    // consecutive-trigger streak must reset…
    const r3 = await context({ messages: mkMsgs(12) }, ctx);
    expect(r3.messages).toHaveLength(8);

    // …so a later single frozen request is trigger 1 again, not 2 — no heal.
    await serverConfirm(pi, ctx, 10);
    const r4 = await context({ messages: mkMsgs(13) }, ctx);
    expect(r4.messages).toHaveLength(8);
    expect(readLog()).not.toContain("stale_window_self_heal");
  });
});

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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

beforeEach(() => {
  // Reset the env-var seeds and the log between tests. Re-seed the conversation
  // id the same way the extension does at module load (it only seeds once).
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
  try {
    fs.rmSync(logPath());
  } catch {
    // no log yet
  }
});

afterEach(() => {
  delete process.env.X_NW_CONVERSATION_ID;
  delete process.env.X_NW_MCR_EXT_VERSION;
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

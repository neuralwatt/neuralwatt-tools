# Oh My Pi with Neuralwatt

[Oh My Pi](https://github.com/can1357/oh-my-pi) (omp) is a terminal AI coding agent with sub-agents, LSP integration, browser automation, a SQLite-backed memory system, and per-role model routing. Neuralwatt is not in omp's built-in catalog, so you register it once in `models.yml` and then route roles to Neuralwatt models in `config.yml`.

Two files do all the work:

| File | Purpose |
|------|---------|
| `~/.omp/agent/models.yml` | Declares the `neuralwatt` provider and its models (ids, context, pricing, capabilities) |
| `~/.omp/agent/config.yml` | Maps omp's model roles (`default`, `task`, `smol`, …) to Neuralwatt model selectors |

Copy-ready examples ship with this recipe: [`models.yml`](./models.yml) and [`config.yml`](./config.yml).

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Oh My Pi **v18+** (verified against omp 18.0.11). Older releases predate the `task`/`tiny`/`advisor` roles, custom `@` role aliases, and the `xhigh`/`max` thinking levels used below.

## Install

```bash
# Homebrew (macOS)
brew install can1357/tap/oh-my-pi

# npm
npm install -g @oh-my-pi/cli
```

## Setup

**1. Export your API key** (add to `~/.zshrc` or `~/.bashrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Install the model catalog:**

```bash
mkdir -p ~/.omp/agent
cp recipes/oh-my-pi/models.yml ~/.omp/agent/models.yml
```

The provider block is the whole integration:

```yaml
providers:
  neuralwatt:
    baseUrl: https://api.neuralwatt.com/v1
    api: openai-completions
    apiKey: NEURALWATT_API_KEY   # env var name; resolved at runtime
    authHeader: true             # sends Authorization: Bearer <key>
    compat:
      supportsDeveloperRole: false   # Neuralwatt expects system, not developer
      supportsReasoningEffort: true
```

**3. Optional — install the role mapping:**

```bash
cp recipes/oh-my-pi/config.yml ~/.omp/agent/config.yml
```

If you already have a `config.yml`, merge the `modelRoles` block from the example instead of overwriting the file.

**4. Refresh the catalog and verify:**

```bash
omp models refresh
omp models find deepseek-v4.1-flash
```

`omp models refresh` forces an online re-fetch of the catalog into omp's model cache (equivalent to deleting `~/.omp/models.db`). `omp models find <substring>` prints each model's context window, max output, **valid thinking levels**, and image support.

**5. Restart omp.** Model and role config is cached per process; a running session picks up `models.yml`/`config.yml` changes on the next start.

## Run

```bash
# Default role from config.yml
omp

# Explicit model or role
omp --model neuralwatt/glm-5.2:max
omp --model @slow

# Switch mid-session with /model (Ctrl+L is the model picker shortcut)
```

## Model catalog

The full catalog is authoritative at `https://api.neuralwatt.com/v1/models`; the shipped `models.yml` mirrors it:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq -r '.data[].id'
```

### Naming: tiers and families

Neuralwatt model ids encode the serving tier:

| Form | Meaning |
|------|---------|
| `<model>` | Standard serving tier: reasoning on, full context and effort range |
| `<model>-fast` | Latency tier — thinking disabled server-side, or capped to a small fixed budget (Kimi K2.7 Code Fast). Cheapest energy per request |
| `<model>-flex` | Discounted **async** tier — requests may be held server-side during peak until capacity opens; best-effort latency, billed at a reduced rate. Intended for overnight/batch agent work, not interactive use. The catalog lists the *standard* per-token rate for flex ids; the discount is applied at billing |
| `<model>-short` | GLM-5.2 200K pool with a bounded reasoning budget — faster, lower-energy serving for everyday coding under 200K tokens |
| `*-flash` | A *model family*, not a tier: smaller/faster models built for cheap high-volume work (GLM-5.3 Flash, DeepSeek V4 Flash, DeepSeek V4.1 Flash) |

Tier suffixes compose: `glm-5.2-short-fast-flex` is the 200K pool, reasoning off, on the flex tier.

### Standard models

Price is per 1M tokens as in / out / cached-in.

| Selector (`neuralwatt/…`) | Context | Thinking levels | Vision | Price |
|---|---|---|---|---|
| `kimi-k3` | 1M | low, high, max | yes | $3.00 / $15.00 / $0.30 |
| `kimi-k3-fast` | 1M | off | yes | $3.00 / $15.00 / $0.30 |
| `glm-5.3` | 1M | low, high, max | – | $1.45 / $4.50 / $0.145 |
| `glm-5.2` | 1M | minimal, low, medium, high, max | – | $1.45 / $4.50 / $0.145 |
| `glm-5.2-fast` | 1M | minimal…max (thinking off by default) | – | $1.45 / $4.50 / $0.145 |
| `glm-5.2-short` | 200K | minimal…max (bounded budget) | – | $1.45 / $4.50 / $0.145 |
| `deepseek-v4-pro` | 1M | low, high, max | – | $1.00 / $3.00 / $0.10 |
| `kimi-k2.7-code` | 262K | always on, no effort control | yes | $0.95 / $4.00 / $0.095 |
| `qwen-3.8-27b` | 262K | minimal, low, medium, high | yes | $0.45 / $3.20 / $0.25 |
| `qwen3.6-35b` | 131K | minimal, low, medium, high | yes | $0.29 / $1.15 / $0.029 |
| `qwen3.6-35b-fast` | 131K | off | yes | $0.29 / $1.15 / $0.029 |
| `gemma-4-31b` | 262K | minimal…xhigh | yes | $0.144 / $0.42 / $0.0144 |
| `nw-auto-energy` | 131K | off | yes | $0.29 / $1.15 / $0.029 |

`-flex` and remaining variant rows are listed in [`models.yml`](./models.yml). Two endpoint caveats worth knowing:

- **Kimi K2.7 Code** reports `reasoning_effort: false` — reasoning is mandatory and cannot be dialed, so a `:<level>` suffix is never sent. The shipped `models.yml` carries a per-model `compat: { supportsReasoningEffort: false }` for this family.
- **GLM-5.2 Fast** is the non-thinking tier (`reasoning_effort=none` by default), but the model still advertises an effort range — an explicit `:high`/`:max` suffix re-enables thinking on that request.

### Flash models

The cheap workhorses. All three are reasoning-capable, 1M-class context (V4.1 Flash serves a 256K window in preview), and priced an order of magnitude below the flagship tier.

| Selector | Context | Thinking levels | Vision | Price (in / out / cached) |
|---|---|---|---|---|
| `glm-5.3-flash` | 1M | low, high, max | yes | $0.15 / $0.50 / $0.03 |
| `deepseek-v4.1-flash` | 262K | low, high, max | yes | $0.15 / $0.60 / $0.015 |
| `deepseek-v4-flash` | 1M | low, high, max | – | $0.14 / $0.28 / $0.028 |

`glm-5.3-flash` is the strongest general default of the three (native vision, 1M context, `low/high/max` reasoning). `deepseek-v4.1-flash` has the cheapest cache reads and native vision at a 256K window. `deepseek-v4-flash` is text-only but cheapest on output.

> Flex variants (`glm-5.3-flash-flex`, `deepseek-v4-flash-flex`, …) are the same models on the discounted async tier. The per-token rate reported by `/v1/models` — and therefore the `cost` block in [`models.yml`](./models.yml) — is the standard rate; the flex discount lands at billing, so omp's cost estimates for these ids are an upper bound. Never assign them to `default`, `smol`, `tiny`, or `advisor` — those roles sit on the interactive critical path and flex requests may be held under load.

## Model roles (advanced)

omp routes work through named roles. `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: neuralwatt/deepseek-v4.1-flash
  plan:    neuralwatt/glm-5.2:max
  slow:    neuralwatt/deepseek-v4-pro:max
  task:    neuralwatt/glm-5.2-short:max
  smol:    neuralwatt/deepseek-v4-flash:off
  tiny:    neuralwatt/deepseek-v4-flash:off
  vision:  neuralwatt/qwen-3.8-27b
  advisor: neuralwatt/glm-5.2:max
defaultThinkingLevel: auto
```

### The roles

| Role | What uses it |
|------|--------------|
| `default` | The main interactive session model |
| `plan` | Architecture and multi-step planning |
| `slow` | Hardest reasoning — deep analysis, gnarly debugging |
| `task` | Delegated subagent work (the `task` tool) |
| `smol` | Fast lookups, triage, mechanical edits |
| `tiny` | Session titles, memory writes, auto-thinking classification; **falls back to `smol`** when unset |
| `vision` | Image input |
| `designer` | UI/UX work |
| `commit` | Commit-message generation |
| `advisor` | Passive per-turn reviewer (advisor runtime) |
| any custom name | Referenced as `@name` from a task agent's frontmatter (see below) |

Set a role from the UI with `/model` → Roles view, or by editing `config.yml`. Flags override per run: `--model`, `--smol`, `--slow`, `--plan`.

### Thinking levels

Every selector may carry a `:<level>` suffix: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, in ascending order (`:max` > `:high`). A bare selector uses `defaultThinkingLevel` (`auto` classifies difficulty per turn).

The valid set is **model-specific** — don't guess it:

```bash
omp models find deepseek-v4.1-flash
# thinking column: low,high,max
```

`find` matches model ids/names, not selector strings, so `omp models find glm-5.2:max` returns empty — that is expected, not a resolution failure. Suffixes are clamped to what the model advertises; an unsupported level on a model without effort control is simply not sent.

For a `:<level>` suffix to reach the wire, the model's `compat` must permit `reasoning_effort`. The shipped `models.yml` sets `supportsReasoningEffort: true` at provider level and overrides it to `false` only where `/v1/models` reports `capabilities.reasoning_effort: false` (currently the three Kimi K2.7 Code tiers). When adding a model, copy that flag from the endpoint — a mismatch either strips the suffix silently or gets the request rejected.

### Concurrency: roles fire in parallel

This is the part that trips people up. `default`, `plan`, and `slow` are the main session — sequential. But `task`, `smol`, and `advisor` all fire **concurrently with the main session**:

```
main session (default/plan/slow) ──┬── task subagent(s)   ─┐
                                   ├── smol              ─┼─ concurrent
                                   └── advisor           ─┘
```

Budget slots accordingly:

- **1-slot model** (e.g. a single-instance flagship): assign it only to `default`/`plan`/`slow`. Keep `task`, `smol`, and `advisor` on other models.
- **2-slot model**: `default`/`plan`/`slow` + one of `task`. Keep `smol` and `advisor` elsewhere.
- **N-slot model**: main session + up to N−1 concurrent roles.

Pinned task agents (frontmatter `model:`, below) use their own model and do **not** consume the `task` role's slots.

### Two useful presets

**Cost-aware** — flash everywhere it is safe, flagship only where reasoning pays:

| Role | Model | Why |
|---|---|---|
| `default` | `glm-5.3-flash` | 1M context, vision, $0.15/$0.50 |
| `task` | `deepseek-v4.1-flash` | cheap delegate, 256K is plenty per subagent |
| `smol` / `tiny` | `deepseek-v4-flash:off` | cheapest, no thinking needed |
| `plan` / `slow` | `glm-5.2:max` | reasoning where it matters |
| `vision` | `qwen-3.8-27b` | native VL |

**Quality-first** — the flagship for the main loop, cheap models for background roles:

| Role | Model |
|---|---|
| `default` / `plan` / `slow` | `kimi-k3:max` |
| `task` | `deepseek-v4.1-flash:high` |
| `smol` / `tiny` | `deepseek-v4-flash:off` |
| `reviewer` | `qwen-3.8-27b` |
| `advisor` | `glm-5.2:max` |

### Custom roles + pinned subagents

omp ships bundled task agents and also discovers yours from `~/.omp/agent/agents/*.md` and `<project>/.omp/agents/*.md`. Frontmatter `model:` accepts a role alias, a concrete selector, or an array tried in order — that is how you pin *different models to different classes of work* without touching the `task` role:

```md
---
name: code-worker
description: Implements changes with full tools.
tools: read, write, edit, grep, find, ls, bash
model: "@coder"
---
You are an expert software engineer...
```

```md
---
name: senior-reviewer
description: Correctness, testability, completeness.
tools: read, grep, find, ls, bash
model: ["@reviewer", "neuralwatt/deepseek-v4-flash:max"]   # fallback chain
---
You are a senior code reviewer...
```

with matching role entries:

```yaml
modelRoles:
  coder:    neuralwatt/glm-5.2:max
  reviewer: neuralwatt/qwen-3.8-27b
```

Resolution order for a task dispatch is `task.agentModelOverrides[agent]` → agent frontmatter `model` list → parent model. Role aliases expand through `modelRoles`, so changing the mapping in one place re-targets every agent that references it. `modelRoles` accepts arbitrary role names — `reviewer`, `fast_worker`, `planner`, whatever fits the workflow.

Related knobs in `config.yml`:

```yaml
task:
  enableEffort: true        # let task items pass lo/med/hi effort hints
  maxEffort: max            # ceiling those hints are clamped to
  agentModelOverrides:      # override a bundled agent's model by name
    sonic: neuralwatt/deepseek-v4-flash:off
```

With `enableEffort`, a task item's coarse `lo`/`med`/`hi` hint maps to the selected model's lowest/middle/highest supported effort and is clamped to `task.maxEffort`.

### Per-project overrides

`config.yml` layers: `defaults < global (~/.omp/agent/config.yml) < project (<cwd>/.omp/config.yml) < PI_CONFIG_FILES overlays < --config overlays`. Use a project file to run a repo on a different default without touching your global config:

```yaml
# <repo>/.omp/config.yml
modelRoles:
  default: neuralwatt/kimi-k2.7-code:high
  task: neuralwatt/deepseek-v4.1-flash
```

`enabledModels` and `disabledProviders` can also be path-scoped:

```yaml
enabledModels:
  - path: ~/work
    models:
      - neuralwatt/glm-5.2
      - neuralwatt/deepseek-v4.1-flash
```

## Session features

- **Advisor** — passively reviews each turn and injects notes. `advisor.enabled: true` in `config.yml`, or `--advisor` per run. Sized by the `advisor` role, so keep it on a fast model.
- **Prewalk** — start expensive (plan), hand off to the `smol` role at the first edit. `--prewalk` / `--prewalk-into <model>`.
- **Thinking control** — `--thinking <off|minimal|low|medium|high|xhigh|max|auto>` per session; `defaultThinkingLevel` globally.
- **Skills** — omp auto-discovers `~/.pi/agent/skills/`; add extra directories with `omp config set skills.customDirectories '["/path/to/skills"]'` or the `skills.customDirectories` list in `config.yml`.

## Verify and troubleshoot

```bash
omp models find <substring>   # resolution + thinking levels for a model
omp models --json              # machine-readable catalog (context, price, levels)
omp models refresh             # force an online re-fetch
omp config get modelRoles      # confirm the role map loaded
```

| Symptom | Cause / fix |
|---|---|
| Neuralwatt models missing from `/model` | `models.yml` failed schema validation — omp falls back to built-in models and surfaces the error. Check YAML and restart (config is cached per process) |
| Model present but not selectable | API key not resolvable in the launching shell. The `apiKey` value is treated as an env var name first, literal second |
| Role change had no effect | Task/eval dispatches reload current global/project/overlay settings; retry the dispatch. Restart only when changing the already-running session's selected model |
| `400` on a `:<level>` selector | The endpoint rejects that effort for the model. Check the `thinking` column from `omp models find`; models with `reasoning_effort: false` (Kimi K2.7 Code) must be used bare |
| `omp models find <id>:max` returns nothing | Expected — `find` matches ids/names, not selectors |

`compat` blocks deep-merge: a model-level `compat` adds to the provider-level block rather than replacing it, so per-model exceptions stay one-line.

## Reference

- [`models.yml`](./models.yml) — full Neuralwatt catalog for omp (all tiers and variants)
- [`config.yml`](./config.yml) — role mapping, task effort, advisor, skills
- omp model/provider config docs: `omp://models.md`
- omp task agent discovery docs: `omp://task-agent-discovery.md`
- Neuralwatt catalog: `https://api.neuralwatt.com/v1/models`

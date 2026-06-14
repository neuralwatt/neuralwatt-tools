# Oh My Pi with Neuralwatt

[Oh My Pi](https://github.com/can1357/oh-my-pi) (omp) is a terminal AI coding agent built on the Pi framework with additional built-in tools (sub-agents, web search, browser automation, LSP) and a SQLite-backed memory system. Neuralwatt models are not included in omp's built-in catalog, so you add them via `models.yml`.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Oh My Pi v14.5+ ([install guide](https://github.com/can1357/oh-my-pi#installation))

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

**2. Create** `~/.omp/agent/models.yml`:

```yaml
providers:
  neuralwatt:
    baseUrl: https://api.neuralwatt.com/v1
    api: openai-completions
    apiKey: NEURALWATT_API_KEY
    authHeader: true
    compat:
      supportsDeveloperRole: false
      supportsReasoningEffort: false
    models:
      - id: Qwen/Qwen3.6-35B-A3B
        name: Qwen3.6 35B
        reasoning: true
        input: [text, image]
        contextWindow: 131056
        maxTokens: 32768
        cost: { input: 0.05, output: 0.10, cacheRead: 0, cacheWrite: 0 }
      - id: moonshotai/Kimi-K2.6
        name: Kimi K2.6
        reasoning: true
        input: [text, image]
        contextWindow: 262128
        maxTokens: 65536
        cost: { input: 0.69, output: 3.22, cacheRead: 0, cacheWrite: 0 }
      - id: moonshotai/Kimi-K2.5
        name: Kimi K2.5
        reasoning: true
        input: [text, image]
        contextWindow: 262128
        maxTokens: 65536
        cost: { input: 0.52, output: 2.59, cacheRead: 0, cacheWrite: 0 }
      - id: zai-org/GLM-5.1-FP8
        name: GLM-5.1
        reasoning: true
        input: [text]
        contextWindow: 202736
        maxTokens: 32768
        cost: { input: 1.10, output: 3.60, cacheRead: 0, cacheWrite: 0 }
      - id: Qwen/Qwen3.5-397B-A17B-FP8
        name: Qwen3.5 397B
        reasoning: true
        input: [text]
        contextWindow: 262128
        maxTokens: 65536
        cost: { input: 0.69, output: 4.14, cacheRead: 0, cacheWrite: 0 }
      - id: MiniMaxAI/MiniMax-M2.5
        name: MiniMax M2.5
        reasoning: true
        input: [text]
        contextWindow: 196592
        maxTokens: 49152
        cost: { input: 0.35, output: 1.38, cacheRead: 0, cacheWrite: 0 }
      - id: mistralai/Devstral-Small-2-24B-Instruct-2512
        name: Devstral 24B
        reasoning: false
        input: [text, image]
        contextWindow: 262128
        maxTokens: 65536
        cost: { input: 0.12, output: 0.35, cacheRead: 0, cacheWrite: 0 }
      - id: openai/gpt-oss-20b
        name: GPT-OSS 20B
        reasoning: true
        input: [text]
        contextWindow: 16368
        maxTokens: 4096
        cost: { input: 0.03, output: 0.16, cacheRead: 0, cacheWrite: 0 }
```

This file replaces the built-in model list for the `neuralwatt` provider. omp loads it on startup and also re-reads it when you open `/model` during a session.

## Run

```bash
omp --model neuralwatt/moonshotai/Kimi-K2.6
```

Or launch omp and switch models with `/model` or `Ctrl+L`.

## Available Models

Browse the full catalog at [portal.neuralwatt.com](https://portal.neuralwatt.com), or query the API:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

## Skills: Reuse Your Pi Skills

Oh My Pi auto-discovers skills from `~/.pi/agent/skills/` (the `skills.enablePiUser` setting defaults to `true`). If you have Neuralwatt-specific skills there, they work without extra configuration.

To add skill directories that omp doesn't scan by default:

```bash
omp config set skills.customDirectories '["/path/to/your/skills"]'
```

## Configuration Notes

- The `apiKey` field accepts a bare environment variable name (e.g., `NEURALWATT_API_KEY`). omp resolves it at runtime. You can also hardcode the key value directly, but using an env var avoids storing secrets in a dotfile.
- `compat` replaces the built-in block wholesale per the DeepSeek integration model — it does not merge. If you need a model-specific compat override, include all fields in that model's `compat` block.
- The `authHeader: true` setting tells omp to send `Authorization: Bearer <key>`. Neuralwatt requires this.
- `supportsDeveloperRole: false` is required because Neuralwatt's OpenAI-compatible API rejects the `developer` role and expects `system`.

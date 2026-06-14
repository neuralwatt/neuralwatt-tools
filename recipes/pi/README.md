# Pi with Neuralwatt

[Pi](https://pi.dev) is a minimal terminal coding agent. Extensions, skills, and prompt templates customize its behavior without modifying Pi internals. Neuralwatt models are not included in Pi's built-in catalog, so you add them via `models.json`.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Pi v0.72+ ([install guide](https://pi.dev))

## Install

```bash
# npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Or via the installer script
curl -fsSL https://pi.dev/install.sh | sh
```

## Setup

**1. Export your API key** (add to `~/.zshrc` or `~/.bashrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Create** `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "neuralwatt": {
      "baseUrl": "https://api.neuralwatt.com/v1",
      "api": "openai-completions",
      "apiKey": "$NEURALWATT_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "Qwen/Qwen3.6-35B-A3B",
          "name": "Qwen3.6 35B",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 131056,
          "maxTokens": 32768,
          "cost": { "input": 0.05, "output": 0.10, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "moonshotai/Kimi-K2.6",
          "name": "Kimi K2.6",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 262128,
          "maxTokens": 65536,
          "cost": { "input": 0.69, "output": 3.22, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "moonshotai/Kimi-K2.5",
          "name": "Kimi K2.5",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 262128,
          "maxTokens": 65536,
          "cost": { "input": 0.52, "output": 2.59, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "zai-org/GLM-5.1-FP8",
          "name": "GLM-5.1",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 202736,
          "maxTokens": 32768,
          "cost": { "input": 1.10, "output": 3.60, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "Qwen/Qwen3.5-397B-A17B-FP8",
          "name": "Qwen3.5 397B",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 262128,
          "maxTokens": 65536,
          "cost": { "input": 0.69, "output": 4.14, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "MiniMaxAI/MiniMax-M2.5",
          "name": "MiniMax M2.5",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 196592,
          "maxTokens": 49152,
          "cost": { "input": 0.35, "output": 1.38, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "mistralai/Devstral-Small-2-24B-Instruct-2512",
          "name": "Devstral 24B",
          "reasoning": false,
          "input": ["text", "image"],
          "contextWindow": 262128,
          "maxTokens": 65536,
          "cost": { "input": 0.12, "output": 0.35, "cacheRead": 0, "cacheWrite": 0 }
        },
        {
          "id": "openai/gpt-oss-20b",
          "name": "GPT-OSS 20B",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 16368,
          "maxTokens": 4096,
          "cost": { "input": 0.03, "output": 0.16, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

This file creates the `neuralwatt` provider in Pi's model registry. It reloads each time you open `/model`, so you can edit it mid-session.

## Run

```bash
pi --model neuralwatt/moonshotai/Kimi-K2.6
```

Or launch Pi and switch models with `/model` or `Ctrl+L`.

## Available Models

Browse the full catalog at [portal.neuralwatt.com](https://portal.neuralwatt.com), or query the API:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

## MCR: 1M Virtual Context

For long-context sessions, install the [Neuralwatt MCR extension](../../plugins/pi/):

```bash
pi install npm:@neuralwatt/pi-mcr-extension
```

This adds MCR-backed models (`neuralwatt/kimi-k2.6-long`, `neuralwatt/glm-5.1-long`) with server-side compaction that gives you a 1M token virtual context window. See the [MCR extension docs](../../plugins/pi/README.md) for details.

> **If you install the MCR extension**, remove the `neuralwatt` provider from `~/.pi/agent/models.json` (or delete the file entirely). The extension registers the `neuralwatt` provider itself, and a hand-edited `models.json` entry will shadow it, preventing the long-context aliases from appearing in `/model`.

## Configuration Notes

- The `apiKey` field supports environment variable interpolation with `$ENV_VAR` or `${ENV_VAR}` syntax. It also supports shell command execution with `!command` for secrets managers (e.g., `"apiKey": "!op read 'op://vault/item/key'"`).
- `authHeader: true` tells Pi to send `Authorization: Bearer <key>`, which Neuralwatt requires.
- `supportsDeveloperRole: false` is required because Neuralwatt's OpenAI-compatible API rejects the `developer` role and expects `system`.
- Per-model `compat` overrides merge with the provider-level `compat` when both are set, so you can add `supportsReasoningEffort: true` on a specific model without re-specifying the provider-level fields.

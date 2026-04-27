# OpenCode with Neuralwatt

[OpenCode](https://opencode.ai) ([GitHub](https://github.com/anomalyco/opencode)) is an AI coding agent CLI that lets you bring your own models.

## Install

See [OpenCode installation docs](https://github.com/anomalyco/opencode?tab=readme-ov-file#installation) for all options, or:

```bash
brew install anomalyco/tap/opencode
```

## Setup

**1. Export your API key** (add to `~/.zshrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Create config** at `~/.config/opencode/opencode.json`:

```json
{
  "model": "neuralwatt/Qwen/Qwen3.5-397B-A17B-FP8",
  "provider": {
    "neuralwatt": {
      "name": "Neuralwatt",
      "npm": "@ai-sdk/openai-compatible",
      "models": {
        "Qwen/Qwen3.5-397B-A17B-FP8": {
          "name": "Qwen3.5 397B",
          "limit": { "context": 262144, "output": 32768 }
        },
        "Qwen/Qwen3.6-35B-A3B": {
          "name": "Qwen3.6 35B",
          "limit": { "context": 131072, "output": 32768 }
        },
        "moonshotai/Kimi-K2.6": {
          "name": "Kimi K2.6",
          "limit": { "context": 262144, "output": 32768 }
        },
        "moonshotai/Kimi-K2.5": {
          "name": "Kimi K2.5",
          "limit": { "context": 262144, "output": 32768 }
        },
        "openai/gpt-oss-20b": {
          "name": "GPT-OSS 20B",
          "limit": { "context": 16384, "output": 4096 }
        },
        "mistralai/Devstral-Small-2-24B-Instruct-2512": {
          "name": "Devstral Small 2",
          "limit": { "context": 262144, "output": 32768 }
        },
        "MiniMaxAI/MiniMax-M2.5": {
          "name": "MiniMax M2.5",
          "limit": { "context": 196608, "output": 32768 }
        },
        "zai-org/GLM-5.1-FP8": {
          "name": "GLM-5.1",
          "limit": { "context": 200000, "output": 32768 }
        },
        "qwen3.6-35b-fast": {
          "name": "Qwen3.6 35B Fast",
          "limit": { "context": 131072, "output": 8192 }
        },
        "glm-5-fast": {
          "name": "GLM-5 Fast",
          "limit": { "context": 200000, "output": 8192 }
        },
        "glm-5.1-fast": {
          "name": "GLM-5.1 Fast",
          "limit": { "context": 200000, "output": 8192 }
        },
        "kimi-k2.6-fast": {
          "name": "Kimi K2.6 Fast",
          "limit": { "context": 262144, "output": 8192 }
        },
        "kimi-k2.5-fast": {
          "name": "Kimi K2.5 Fast",
          "limit": { "context": 262144, "output": 8192 }
        },
        "qwen3.5-397b-fast": {
          "name": "Qwen3.5 397B Fast",
          "limit": { "context": 262144, "output": 8192 }
        }
      },
      "options": {
        "baseURL": "https://api.neuralwatt.com/v1",
        "apiKey": "{env:NEURALWATT_API_KEY}"
      }
    }
  }
}
```

## Available models

See the full list with pricing at [portal.neuralwatt.com/pricing](https://portal.neuralwatt.com/pricing). All models use the same provider config above.

**Reasoning models:** `Qwen/Qwen3.5-397B-A17B-FP8`, `Qwen/Qwen3.6-35B-A3B`, `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.5`, `MiniMaxAI/MiniMax-M2.5`, `zai-org/GLM-5.1-FP8`

**Fast variants** (no reasoning mode, lower latency): `qwen3.6-35b-fast`, `glm-5-fast`, `glm-5.1-fast`, `kimi-k2.6-fast`, `kimi-k2.5-fast`, `qwen3.5-397b-fast`

**Other:** `openai/gpt-oss-20b`, `mistralai/Devstral-Small-2-24B-Instruct-2512`

## Run

```bash
opencode
```

## Energy Usage Command

Add a `/nw-usage` command to check your energy consumption from within OpenCode.

**1. Install the script** (see [scripts/README.md](../../scripts/)):

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-usage ~/.local/bin/nw-usage
```

**2. Add the command** to your `~/.config/opencode/opencode.json`:

```json
{
  "command": {
    "nw-usage": {
      "description": "Show Neuralwatt energy usage",
      "template": "Here is my Neuralwatt API usage:\n\n!`nw-usage`\n\nReport this to the user."
    }
  }
}
```

**3. Use it** by typing `/nw-usage` in OpenCode.

### Alternative: Markdown file

Instead of JSON config, create `.opencode/command/nw-usage.md` in your project:

```markdown
---
description: Show Neuralwatt energy usage
---
Here is my Neuralwatt API usage:

!`nw-usage`

Report this to the user.
```

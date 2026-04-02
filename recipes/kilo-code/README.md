# Kilo Code CLI with Neuralwatt

[Kilo Code](https://kilo.ai) ([GitHub](https://github.com/Kilo-Org/kilocode)) is an open-source AI coding agent with a CLI that supports custom OpenAI-compatible providers.

![Kilo CLI with Neuralwatt](kilo-cli.png)

## Install

See [Kilo Code installation docs](https://kilo.ai/docs/getting-started/installation) for all options.

```bash
# npm (all platforms)
npm install -g @kilocode/cli

# or run without installing
npx @kilocode/cli

# Homebrew (macOS/Linux)
brew install Kilo-Org/tap/kilo
```

## Setup

**1. Export your API key** (add to your shell profile):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Create config** at `~/.config/kilo/kilo.json`:

```json
{
  "model": "neuralwatt/Qwen/Qwen3.5-397B-A17B-FP8",
  "provider": {
    "neuralwatt": {
      "name": "Neuralwatt",
      "env": ["NEURALWATT_API_KEY"],
      "options": {
        "baseURL": "https://api.neuralwatt.com/v1"
      },
      "models": {
        "Qwen/Qwen3.5-397B-A17B-FP8": {
          "name": "Qwen3.5 397B MoE",
          "tool_call": true,
          "limit": { "context": 262144, "output": 32768 }
        },
        "Qwen/Qwen3.5-35B-A3B": {
          "name": "Qwen3.5 35B MoE",
          "tool_call": true,
          "limit": { "context": 32768, "output": 8192 }
        },
        "moonshotai/Kimi-K2.5": {
          "name": "Kimi K2.5",
          "reasoning": true,
          "tool_call": true,
          "limit": { "context": 262144, "output": 32768 }
        },
        "mistralai/Devstral-Small-2-24B-Instruct-2512": {
          "name": "Devstral Small 24B",
          "tool_call": true,
          "limit": { "context": 262144, "output": 32768 }
        },
        "zai-org/GLM-5-FP8": {
          "name": "GLM-5",
          "tool_call": true,
          "limit": { "context": 131072, "output": 32768 }
        },
        "MiniMaxAI/MiniMax-M2.5": {
          "name": "MiniMax M2.5",
          "tool_call": true,
          "limit": { "context": 196608, "output": 32768 }
        },
        "openai/gpt-oss-20b": {
          "name": "GPT-OSS 20B",
          "tool_call": true,
          "limit": { "context": 16384, "output": 8192 }
        }
      }
    }
  },
  "command": {
    "nw-usage": {
      "description": "Show Neuralwatt energy usage",
      "template": "Here is my Neuralwatt API usage:\n\n!`nw-usage`\n\nReport this to the user."
    }
  }
}
```

Switch models at runtime with `Ctrl+M` or by editing the `"model"` field (format: `neuralwatt/<model-id>`).

## Run

```bash
kilo
```

## Energy Usage Command (optional)

The config above already includes a `/nw-usage` command. To use it, install the script:

```bash
curl -fsSL https://raw.githubusercontent.com/neuralwatt/neuralwatt-tools/main/scripts/nw-usage \
  -o ~/.local/bin/nw-usage && chmod +x ~/.local/bin/nw-usage
```

Then type `/nw-usage` in Kilo Code.
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

# Kilo Code CLI with Neuralwatt

[Kilo Code](https://kilo.ai) ([GitHub](https://github.com/Kilo-Org/kilocode)) is an open-source AI coding agent with a CLI that supports custom OpenAI-compatible providers.

## Install

See [Kilo Code installation docs](https://kilo.ai/docs/getting-started/installation) for all options, or:

```bash
brew install Kilo-Org/tap/kilo
```

## Setup

**1. Export your API key** (add to `~/.zshrc`):

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
      "models": {
        "Qwen/Qwen3.5-397B-A17B-FP8": {
          "name": "Qwen3.5 397B"
        }
      },
      "options": {
        "baseURL": "https://api.neuralwatt.com/v1"
      }
    }
  }
}
```

## Run

```bash
kilo
```

## Energy Usage Command

Add a `/nw-usage` command to check your energy consumption from within Kilo Code.

**1. Install the script** (see [scripts/README.md](../../scripts/)):

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-usage ~/.local/bin/nw-usage
```

**2. Add the command** to your `~/.config/kilo/kilo.json`:

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

**3. Use it** by typing `/nw-usage` in Kilo Code.

### Alternative: Markdown file

Instead of JSON config, create `.kilo/command/nw-usage.md` in your project:

```markdown
---
description: Show Neuralwatt energy usage
---
Here is my Neuralwatt API usage:

!`nw-usage`

Report this to the user.
```

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

**2. Generate config** using the `nw-opencode-config` script:

```bash
# Auto-generate config from the live Neuralwatt API
nw-opencode-config --write

# Or specify a default model
nw-opencode-config --write --default zai-org/GLM-5.1-FP8
```

This fetches all available models from the Neuralwatt API and writes the config to `~/.config/opencode/opencode.json`. It **merges** with your existing config — your other providers and settings are preserved.

### Manual config

If you prefer to create the config manually, create `~/.config/opencode/opencode.json`:

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

Use `nw-opencode-config --list` to see all available models with their context limits.

## Run

```bash
opencode
```

## nw-opencode-config

The `nw-opencode-config` script generates an OpenCode config from the live Neuralwatt API.

```bash
nw-opencode-config                        # Print config to stdout
nw-opencode-config --write                # Write to ~/.config/opencode/opencode.json
nw-opencode-config --models-only          # Print just the models block
nw-opencode-config --list                 # List available models
nw-opencode-config --include-aliases      # Include alias/fast models
nw-opencode-config --default MODEL_ID     # Set default model
nw-opencode-config --help
```

### How it works

1. Fetches model IDs and context limits from `https://api.neuralwatt.com/v1/models`
2. Merges with curated metadata ([`opencode-models.json`](../../scripts/opencode-models.json)) for display names, output limits, and model-specific options (e.g., Kimi K2.5's recommended `repetitionPenalty`)
3. Outputs a valid `opencode.json` with the Neuralwatt provider and `/nw-usage` command

New models appear automatically when added to the API. To update your config, just re-run `nw-opencode-config --write`.

### Installation

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-opencode-config ~/.local/bin/
```

## Energy Usage Command

A `/nw-usage` command is included in the auto-generated config. To use it:

**1. Install the script** (see [scripts/README.md](../../scripts/)):

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-usage ~/.local/bin/nw-usage
```

**2. Use it** by typing `/nw-usage` in OpenCode.

### Alternative: Markdown file

Instead of the JSON config command, create `.opencode/command/nw-usage.md` in your project:

```markdown
---
description: Show Neuralwatt energy usage
---
Here is my Neuralwatt API usage:

!`nw-usage`

Report this to the user.
```

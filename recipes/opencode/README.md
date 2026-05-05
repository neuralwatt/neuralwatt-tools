# OpenCode with Neuralwatt

[OpenCode](https://opencode.ai) ([GitHub](https://github.com/sst/opencode)) is an AI coding agent CLI. Neuralwatt is a built-in provider in OpenCode's model catalog, so the only thing you need to do is set your API key.

## Install

See [OpenCode installation docs](https://opencode.ai/docs/) for all options, or:

```bash
brew install anomalyco/tap/opencode
```

## Setup

Export your API key (add to `~/.zshrc` or `~/.bashrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

Launch OpenCode:

```bash
opencode
```

Open the model picker (`/models`), filter by "Neuralwatt", and pick a model.

## Set a Default Model

Optional. Add to `~/.config/opencode/opencode.json` (global) or `./opencode.json` (per-project):

```json
{
  "model": "neuralwatt/zai-org/GLM-5.1-FP8"
}
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

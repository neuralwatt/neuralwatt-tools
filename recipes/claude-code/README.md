# Claude Code with Neuralwatt

[Claude Code](https://github.com/anthropics/claude-code) is Anthropic's official AI coding CLI. Using [claude-code-router](https://github.com/musistudio/claude-code-router), you can route requests to Neuralwatt's OpenAI-compatible API.

> **Note:** Using Claude Code with non-Anthropic models is not officially supported by Anthropic. This recipe documents an alternative configuration for users who want to use the Claude Code interface with Neuralwatt's models.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Node.js 18+

## Install

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @anthropic-ai/claude-code-router
```

## Setup

**1. Export your API key** (add to `~/.zshrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Create config** at `~/.claude-code-router/config.json`:

```json
{
  "Providers": [
    {
      "name": "neuralwatt",
      "api_base_url": "https://api.neuralwatt.com/v1/chat/completions",
      "api_key_env": "NEURALWATT_API_KEY",
      "models": ["Qwen/Qwen3-Coder-480B-A35B-Instruct"]
    }
  ],
  "Router": {
    "default": "neuralwatt,Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "background": "neuralwatt,Qwen/Qwen3-Coder-480B-A35B-Instruct"
  }
}
```

## Run

```bash
ccr code
```

## Commands

| Command | Description |
|---------|-------------|
| `ccr start` | Start the router |
| `ccr stop` | Stop the router |
| `ccr code` | Start router and launch Claude Code |
| `ccr status` | Check router status |

## Available Models

Check [portal.neuralwatt.com](https://portal.neuralwatt.com) or use the `/v1/models` endpoint to see available models.

## Statusline: Show Today's Usage

Display your daily Neuralwatt usage directly in Claude Code's statusline. This shows **today's total usage** across all sessions, not the current session.

![Claude Code statusline showing Neuralwatt usage](../../images/claude-code-statusline.png)

**1. Install the `nw-usage` script:**

```bash
# Copy to somewhere in your PATH
cp scripts/nw-usage ~/.local/bin/
chmod +x ~/.local/bin/nw-usage

# Store your API key
mkdir -p ~/.config/neuralwatt
echo "your-api-key" > ~/.config/neuralwatt/api_key
chmod 600 ~/.config/neuralwatt/api_key
```

**2. Add to Claude Code settings** (`~/.claude/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "nw-usage --tmux --color '1;32'"
  }
}
```

**3. Restart Claude Code** to see usage in the statusline (in bright green):

```
↗42 ⚡156Wh
```

The `--color` flag takes an ANSI code (e.g., `1;32` for bright green, `0;36` for cyan). Quote the color code to prevent the semicolon from being interpreted as a command separator. The `--tmux` flag caches results for 5 minutes to avoid excessive API calls.

See the [nw-usage script docs](../../scripts/) for more output options.

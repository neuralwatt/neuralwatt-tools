# Claude Code with NeuralWatt

[Claude Code](https://github.com/anthropics/claude-code) is Anthropic's official AI coding CLI. Using [claude-code-router](https://github.com/musistudio/claude-code-router), you can route requests to NeuralWatt's OpenAI-compatible API.

> **Note:** Using Claude Code with non-Anthropic models is not officially supported by Anthropic. This recipe documents an alternative configuration for users who want to use the Claude Code interface with NeuralWatt's models.

## Prerequisites

- [NeuralWatt API key](https://portal.neuralwatt.com)
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

## Energy Usage

Want to see your energy consumption? Install the [nw-usage script](../../scripts/) to track usage from the command line or in your tmux status bar.

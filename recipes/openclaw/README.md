# OpenClaw with Neuralwatt

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant gateway that connects to messaging platforms (Telegram, Discord, WhatsApp, Slack, and more) and runs your choice of model behind it. Since Neuralwatt exposes an OpenAI-compatible API, OpenClaw can use it as a provider with a few lines of config.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Node.js 22.16+ (Node 24 recommended)

## Install

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

Or via npm:

```bash
npm install -g openclaw@latest
```

## Setup

### Option A: Interactive onboarding

The fastest path. OpenClaw's onboard wizard handles provider setup, API key, and channel configuration in one go:

```bash
openclaw onboard --install-daemon \
  --auth-choice custom-api-key \
  --custom-base-url "https://api.neuralwatt.com/v1" \
  --custom-model-id "Qwen/Qwen3.5-397B-A17B-FP8" \
  --custom-compatibility openai \
  --custom-api-key "$NEURALWATT_API_KEY"
```

When prompted, paste your Neuralwatt API key (or pass it via `--custom-api-key` as shown above).

> **Note:** The onboard wizard uses conservative defaults (16k context, 4k max output). For the full 128k context window our API supports, use Option B or manually edit `~/.openclaw/openclaw.json` after onboarding to set `contextWindow: 131072` and `maxTokens: 32768`.

### Option B: Manual config

**1. Export your API key** (add to `~/.zshrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Register the API key with OpenClaw** so the gateway service can access it:

```bash
openclaw config set models.providers.neuralwatt.apiKey \
  --ref-provider default --ref-source env --ref-id NEURALWATT_API_KEY
```

> **Why not just put the key in the JSON?** OpenClaw resolves secrets through a ref system, not bare strings. A bare `"apiKey": "NEURALWATT_API_KEY"` is sent literally and will return 401. The ref approach also makes the key available to the systemd gateway service, which doesn't inherit your shell environment.

**3. Edit** `~/.openclaw/openclaw.json` (JSON5, comments allowed):

```json5
{
  gateway: {
    mode: "local",
  },
  models: {
    mode: "merge",
    providers: {
      neuralwatt: {
        baseUrl: "https://api.neuralwatt.com/v1",
        // apiKey is set via `openclaw config set` (step 2)
        api: "openai-completions",
        models: [
          {
            id: "Qwen/Qwen3.5-397B-A17B-FP8",
            name: "Qwen3.5 397B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 32768,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "neuralwatt/Qwen/Qwen3.5-397B-A17B-FP8" },
    },
  },
}
```

A complete example config (with identity and channels) is in [`openclaw.json`](openclaw.json) alongside this README.

**4. Start the gateway:**

```bash
openclaw gateway start
```

**5. Verify:**

```bash
openclaw gateway health
openclaw models list
```

You should see your Neuralwatt model in the list.

## Channels

OpenClaw supports 20+ messaging channels. The most common ones:

| Channel | Setup |
|---------|-------|
| Web UI | Built-in at `http://localhost:18789` |
| Telegram | Add `channels.telegram.token` in config |
| Discord | Add `channels.discord.token` in config |
| WhatsApp | Add `channels.whatsapp.allowFrom` and scan QR |

See the [OpenClaw channel docs](https://github.com/openclaw/openclaw/tree/main/docs/channels) for full setup instructions per channel.

## Available Models

Check [portal.neuralwatt.com](https://portal.neuralwatt.com) or query the API:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

To add more models, append them to the `models` array in your provider config.

## Energy Usage

Neuralwatt returns energy consumption data with every API response. You can check your daily usage with the [`nw-usage`](../../scripts/) script:

```bash
nw-usage
```

```
Neuralwatt Usage for 2026-03-26
  Requests: 42
  Energy: 156Wh (561600J)
```

### Energy-aware OpenClaw skill (future)

OpenClaw supports custom skills (markdown files that teach the agent specific behaviors). A Neuralwatt energy skill could teach the assistant to fetch and display per-session energy data, similar to how [EcoClaw](https://github.com/thmtz/ecoclaw) appended energy receipts to every response. This is a natural next step beyond the basic provider integration.

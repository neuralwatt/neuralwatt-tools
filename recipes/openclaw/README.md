# OpenClaw with Neuralwatt

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant gateway that connects to messaging platforms (Telegram, Discord, WhatsApp, Slack, and more) and runs your choice of model behind it. Since Neuralwatt exposes an OpenAI-compatible API, OpenClaw can use it as a provider with zero code changes.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Node.js 22.16+ (Node 24 recommended)

## Install

```bash
npm install -g openclaw@latest
```

Or via the install script:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## Setup

Run `openclaw onboard` with your Neuralwatt API key:

```bash
openclaw onboard --non-interactive --accept-risk \
  --install-daemon \
  --auth-choice custom-api-key \
  --custom-provider-id neuralwatt \
  --custom-base-url "https://api.neuralwatt.com/v1" \
  --custom-model-id "Qwen/Qwen3.5-397B-A17B-FP8" \
  --custom-compatibility openai \
  --custom-api-key "your-api-key-here" \
  --secret-input-mode plaintext
```

This creates the config, stores the API key, and installs the gateway as a background service in one step.

The onboarding wizard uses conservative defaults (16k context, 4k max output). After it finishes, update the model limits to match what Neuralwatt supports:

```bash
openclaw config set models.providers.neuralwatt.models.0.contextWindow 131072 --strict-json
openclaw config set models.providers.neuralwatt.models.0.maxTokens 32768 --strict-json
```

Verify everything is working:

```bash
openclaw gateway health
openclaw models list
```

You should see `neuralwatt/Qwen/Qwen3.5-397B-A17B-FP8` in the list. The WebChat UI is at `http://localhost:18789`.

### Alternative: manual config

If you prefer to set up the config file by hand, create `~/.openclaw/openclaw.json`:

```bash
mkdir -p ~/.openclaw
```

```json5
// ~/.openclaw/openclaw.json
{
  gateway: {
    mode: "local",
  },
  models: {
    mode: "merge",
    providers: {
      neuralwatt: {
        baseUrl: "https://api.neuralwatt.com/v1",
        apiKey: "your-api-key-here",
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
    list: [
      {
        id: "main",
        identity: { name: "Assistant", theme: "helpful assistant" },
      },
    ],
  },
}
```

A copy-pasteable version is also available as [`openclaw.json`](openclaw.json).

Then install and start the gateway:

```bash
openclaw gateway install
openclaw gateway start
```

## Channels

OpenClaw supports 20+ messaging channels. The most common ones:

| Channel | Setup | Docs |
|-|-|-|
| Web UI | Built-in at `http://localhost:18789` | |
| Telegram | Add `channels.telegram.token` in config | [telegram.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/telegram.md) |
| Discord | Add `channels.discord.token` in config | [discord.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/discord.md) |
| WhatsApp | Add `channels.whatsapp.allowFrom` and scan QR | [whatsapp.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/whatsapp.md) |
| Slack | Add `channels.slack.token` in config | [slack.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/slack.md) |
| Signal | Add `channels.signal` config | [signal.md](https://github.com/openclaw/openclaw/blob/main/docs/channels/signal.md) |

See the [full channel list](https://github.com/openclaw/openclaw/tree/main/docs/channels) and [OpenClaw docs](https://docs.openclaw.ai) for more.

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

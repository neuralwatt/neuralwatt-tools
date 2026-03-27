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

**1. Export your API key** (add to `~/.zshrc` or equivalent):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Copy the example config:**

```bash
mkdir -p ~/.openclaw
cp openclaw.json ~/.openclaw/openclaw.json
```

The example [`openclaw.json`](openclaw.json) alongside this README has everything pre-configured: gateway mode, provider, model with correct context window (128k) and output limits (32k).

**3. Register your API key with OpenClaw:**

```bash
openclaw config set models.providers.neuralwatt.apiKey \
  --ref-provider default --ref-source env --ref-id NEURALWATT_API_KEY
```

OpenClaw resolves secrets through a ref system rather than reading bare strings from the config. This command wires up the env var so both the CLI and the systemd gateway service can access it.

**4. Start the gateway:**

```bash
openclaw gateway start
```

**5. Verify:**

```bash
openclaw gateway health
openclaw models list
```

You should see `neuralwatt/Qwen/Qwen3.5-397B-A17B-FP8` in the list. The WebChat UI is at `http://localhost:18789`.

### Alternative: interactive onboarding

If you prefer a wizard, `openclaw onboard` can set up the provider in one command:

```bash
openclaw onboard --install-daemon \
  --auth-choice custom-api-key \
  --custom-base-url "https://api.neuralwatt.com/v1" \
  --custom-model-id "Qwen/Qwen3.5-397B-A17B-FP8" \
  --custom-compatibility openai \
  --custom-api-key "$NEURALWATT_API_KEY"
```

The wizard uses conservative defaults (16k context, 4k max output). After onboarding, edit `~/.openclaw/openclaw.json` to set `contextWindow: 131072` and `maxTokens: 32768` for the full limits.

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

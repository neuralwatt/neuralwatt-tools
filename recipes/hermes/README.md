# Hermes Agent with Neuralwatt

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is a self-improving AI agent from [Nous Research](https://nousresearch.com) that runs locally or on a VPS and can talk to you from Telegram, Discord, Slack, WhatsApp, Signal, or a terminal UI. It accepts any OpenAI-compatible endpoint, so you can point it at the Neuralwatt API as the inference backend.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Linux, macOS, WSL2, or Termux (native Windows is not supported)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.zshrc   # or ~/.bashrc
```

The installer creates `~/.hermes/` with `config.yaml`, `.env`, and the agent source tree.

## Setup

Hermes discovers user-installed provider plugins from `~/.hermes/plugins/model-providers/<name>/`. This recipe ships a small Neuralwatt provider plugin (two files) that registers Neuralwatt as a first-class provider — so it appears in `hermes status` and the `/model` picker with the live model catalog, and uses its own `NEURALWATT_API_KEY` instead of hijacking the OpenAI environment variables.

Install the plugin:

```bash
mkdir -p ~/.hermes/plugins/model-providers/neuralwatt
curl -fsSL https://raw.githubusercontent.com/neuralwatt/neuralwatt-tools/main/recipes/hermes/plugin/__init__.py \
  -o ~/.hermes/plugins/model-providers/neuralwatt/__init__.py
curl -fsSL https://raw.githubusercontent.com/neuralwatt/neuralwatt-tools/main/recipes/hermes/plugin/plugin.yaml \
  -o ~/.hermes/plugins/model-providers/neuralwatt/plugin.yaml
```

Point Hermes at Neuralwatt in `~/.hermes/config.yaml`:

```yaml
model:
  default: glm-5.2
  provider: neuralwatt
```

Then add your key to `~/.hermes/.env`:

```bash
NEURALWATT_API_KEY=your-api-key-here
```

> **Upgrading from the old recipe?** Earlier versions of this guide pointed `OPENAI_API_KEY` and `OPENAI_BASE_URL` at Neuralwatt. Remove both from `~/.hermes/.env` — leaving `OPENAI_BASE_URL` set can misroute Hermes' OpenAI and OpenRouter fallbacks.

Verify the install:

```bash
hermes doctor
```

`hermes doctor` reports Neuralwatt as configured and probes `https://api.neuralwatt.com/v1/models`.

## Run

```bash
hermes
```

You can swap models mid-session with `/model`. The picker autocompletes the Neuralwatt catalog, which the plugin live-fetches from `https://api.neuralwatt.com/v1/models` — so newly released models appear without any plugin update.

## Available Models

The `/model` picker lists the live catalog. To browse it outside Hermes, see [portal.neuralwatt.com](https://portal.neuralwatt.com) or query the API directly (the key lives in `~/.hermes/.env`, so `export NEURALWATT_API_KEY=...` in your shell first):

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

Model IDs are bare and lowercase (for example `glm-5.2`, `kimi-k2.7-code`, `qwen3.5-397b`). Use the exact IDs returned by `/v1/models` for your key.

## Messaging Gateway

Hermes can run as a background gateway that bridges Telegram, Discord, Slack, WhatsApp, Signal, and email into a single agent. Configure it with:

```bash
hermes gateway setup
hermes gateway start
```

See the [messaging gateway guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging) for platform-specific setup.

# Hermes Agent with Neuralwatt

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is a self-improving AI agent from [Nous Research](https://nousresearch.com) that runs locally or on a VPS and can talk to you from Telegram, Discord, Slack, WhatsApp, Signal, or a terminal UI. It supports any OpenAI-compatible endpoint, so Neuralwatt works as a drop-in provider.

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

Hermes treats any non-blessed OpenAI-compatible endpoint as a `custom` provider. Two small edits wire Neuralwatt in.

Edit `~/.hermes/config.yaml` and set the `model` block:

```yaml
model:
  default: "moonshotai/Kimi-K2.5"
  provider: "custom"
  base_url: "https://api.neuralwatt.com/v1"
```

Then append your key to `~/.hermes/.env`:

```bash
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.neuralwatt.com/v1
```

Hermes reads `OPENAI_API_KEY` and `OPENAI_BASE_URL` when the provider is `custom`.

Verify the install:

```bash
hermes doctor
```

## Run

```bash
hermes
```

You can swap models mid-session with `/model <model-id>`. Hermes won't autocomplete the Neuralwatt catalog, so type the full model ID manually (for example `/model Qwen/Qwen3.5-397B-A17B-FP8`).

## Available Models

Browse the full catalog at [portal.neuralwatt.com](https://portal.neuralwatt.com), or query the API directly:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

## Messaging Gateway

Hermes can run as a background gateway that bridges Telegram, Discord, Slack, WhatsApp, Signal, and email into a single agent. Configure it with:

```bash
hermes gateway setup
hermes gateway start
```

See the [messaging gateway guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging) for platform-specific setup.

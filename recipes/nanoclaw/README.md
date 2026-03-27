# NanoClaw with Neuralwatt

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a lightweight AI assistant that runs in containers, connecting to WhatsApp, Telegram, Discord, and other messaging channels. It's built on the Anthropic Agent SDK, which normally talks to Claude. Using a translation proxy, you can point it at Neuralwatt instead.

> **Note:** Using NanoClaw with non-Anthropic models is not officially supported by NanoClaw or Anthropic.

## How It Works

NanoClaw agents speak the Anthropic Messages API. Neuralwatt exposes an OpenAI-compatible Chat Completions API. A translation proxy converts between the two formats:

```
NanoClaw container → Anthropic Messages API
  → Translation proxy (localhost:3000)
    → OpenAI Chat Completions → api.neuralwatt.com/v1
```

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- A working [NanoClaw](https://github.com/qwibitai/nanoclaw) installation
- Node.js 18+ and Git

## Setup

**1. Export your API key** (add to `~/.zshrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

**2. Install the translation proxy:**

We use [anthropic-proxy](https://github.com/maxnowack/anthropic-proxy), a small Node.js server that translates Anthropic requests to OpenAI format. The stock version skips auth headers for custom endpoints, so we apply a one-line patch:

```bash
git clone https://github.com/maxnowack/anthropic-proxy.git ~/neuralwatt-proxy
cd ~/neuralwatt-proxy
npm install
sed -i 's/const requiresApiKey = !process.env.ANTHROPIC_PROXY_BASE_URL/const requiresApiKey = true/' index.js
```

**3. Start the proxy:**

```bash
cd ~/neuralwatt-proxy
ANTHROPIC_PROXY_BASE_URL=https://api.neuralwatt.com \
OPENROUTER_API_KEY=$NEURALWATT_API_KEY \
COMPLETION_MODEL=Qwen/Qwen3.5-397B-A17B-FP8 \
REASONING_MODEL=Qwen/Qwen3.5-397B-A17B-FP8 \
node index.js
```

The proxy listens on port 3000 by default. Set `PORT=<number>` to change it.

**4. Switch NanoClaw to the native credential proxy:**

NanoClaw's default credential mechanism (OneCLI) manages API keys outside the container and routes traffic through its own gateway. To use Neuralwatt instead, switch to the native credential proxy, which reads `ANTHROPIC_BASE_URL` from `.env`:

```bash
cd /path/to/nanoclaw
claude /use-native-credential-proxy
```

Then set the following in your NanoClaw `.env`:

```bash
ANTHROPIC_BASE_URL=http://host.docker.internal:3000
ANTHROPIC_API_KEY=not-used-but-required
```

`host.docker.internal` lets containers reach the proxy running on the host. NanoClaw handles the `--add-host` flag automatically on Linux.

**5. Restart NanoClaw:**

```bash
npm run dev
```

Send a test message through any connected channel. The agent should respond using the Neuralwatt model.

## Verify

Test the proxy directly:

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: anything" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "messages": [{"role": "user", "content": "Say hello and tell me what model you are."}]
  }' | jq .
```

The response should come from Qwen, not Claude. The proxy logs will show requests being translated and forwarded.

## Available Models

Check [portal.neuralwatt.com](https://portal.neuralwatt.com) or query the API:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

To switch models, change `COMPLETION_MODEL` and `REASONING_MODEL` when starting the proxy.

## Limitations

The proxy translates tool schemas between Anthropic and OpenAI formats. Complex tool definitions may hit edge cases, so test your specific workflows. NanoClaw sends Claude model names but the proxy ignores them, routing everything to `COMPLETION_MODEL`. The proxy normalizes multi-part content to plain text, so image inputs may not survive the translation.

## Energy Usage

Neuralwatt returns energy data with every response. Check your usage with the [`nw-usage`](../../scripts/) script:

```bash
nw-usage
```

```
Neuralwatt Usage for 2026-03-27
  Requests: 42
  Energy: 156Wh (561600J)
```

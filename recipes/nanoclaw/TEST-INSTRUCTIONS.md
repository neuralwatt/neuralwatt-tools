# Testing the NanoClaw + Neuralwatt Recipe

Self-contained test plan for validating the translation proxy that lets NanoClaw talk to Neuralwatt. No prior context needed.

## Background

NanoClaw is an AI assistant built on the Anthropic Agent SDK (speaks Anthropic Messages API). Neuralwatt serves open-source models like Qwen via an OpenAI-compatible API at `api.neuralwatt.com/v1`. A translation proxy bridges the two formats.

You don't need a full NanoClaw installation. The core question is whether the proxy correctly translates Anthropic-format requests to OpenAI format, forwards them to Neuralwatt, and translates responses back.

## Prerequisites

- Node.js 18+ and Git
- A Neuralwatt API key set as `NEURALWATT_API_KEY`. Get a free key at https://portal.neuralwatt.com if needed.

## Tests

**1. Verify Neuralwatt API access:**

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

You should see model IDs like `Qwen/Qwen3.5-397B-A17B-FP8`.

**2. Set up the translation proxy:**

```bash
cd /tmp
git clone https://github.com/maxnowack/anthropic-proxy.git neuralwatt-proxy
cd neuralwatt-proxy
npm install

# The stock proxy skips auth headers for custom URLs. Patch it:
sed -i 's/const requiresApiKey = !process.env.ANTHROPIC_PROXY_BASE_URL/const requiresApiKey = true/' index.js

# Verify:
grep 'const requiresApiKey' index.js
# Should show: const requiresApiKey = true
```

**3. Start the proxy:**

```bash
ANTHROPIC_PROXY_BASE_URL=https://api.neuralwatt.com \
OPENROUTER_API_KEY=$NEURALWATT_API_KEY \
COMPLETION_MODEL=Qwen/Qwen3.5-397B-A17B-FP8 \
REASONING_MODEL=Qwen/Qwen3.5-397B-A17B-FP8 \
PORT=3000 \
node index.js &

sleep 2
```

**4. Basic request (non-streaming):**

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 150,
    "stream": false,
    "messages": [
      {"role": "user", "content": "Say hello and identify what model you are. Be brief."}
    ]
  }' | jq .
```

Expected: JSON in Anthropic Messages format with `type: "message"`, a `content` array containing a `text` block, `usage` with token counts. The model should identify as Qwen, not Claude.

**5. Streaming request:**

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 150,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Count from 1 to 5."}
    ]
  }'
```

Expected: SSE stream with `message_start`, `content_block_start`, multiple `content_block_delta` events with `text_delta`, then `content_block_stop`, `message_delta` (with `stop_reason: "end_turn"`), and `message_stop`.

**6. Tool calls:**

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 300,
    "stream": false,
    "messages": [
      {"role": "user", "content": "What is the weather in San Francisco?"}
    ],
    "tools": [
      {
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "input_schema": {
          "type": "object",
          "properties": {
            "location": {"type": "string", "description": "City and state"}
          },
          "required": ["location"]
        }
      }
    ]
  }' | jq .
```

Expected: Response contains a `tool_use` content block with `name: "get_weather"` and an `input` object like `{"location": "San Francisco, CA"}`.

**7. System messages:**

```bash
curl -s http://localhost:3000/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: placeholder" \
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 100,
    "stream": false,
    "system": [{"type": "text", "text": "You are a pirate. Respond in pirate speak only."}],
    "messages": [
      {"role": "user", "content": "How are you today?"}
    ]
  }' | jq .
```

Expected: Response in pirate speak, confirming system messages reach the model.

**8. Cleanup:**

```bash
kill %1 2>/dev/null
rm -rf /tmp/neuralwatt-proxy
```

## What to Report

For each test: pass or fail, with actual output for failures. Note whether the `sed` patch applied cleanly and whether the model identified as Qwen (not Claude).

Also read the recipe README at `recipes/nanoclaw/README.md` and flag anything wrong, unclear, or missing.

## Troubleshooting

Connection refused on port 3000 means the proxy failed to start. Check its stderr.

401/403 from Neuralwatt means the API key isn't being forwarded. Verify the `sed` patch applied and that `NEURALWATT_API_KEY` is set.

Unparseable JSON in tool call `input` fields usually means the model's tool calling isn't as reliable as Claude's. That's a model limitation, not a proxy bug.

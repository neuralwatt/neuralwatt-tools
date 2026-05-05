# Open WebUI with Neuralwatt

[Open WebUI](https://github.com/open-webui/open-webui) is a self-hosted, ChatGPT-style web UI for LLMs. It speaks the OpenAI API natively, so pointing it at Neuralwatt takes two environment variables and the model list auto-discovers from `/v1/models`.

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)
- Docker

## Install & Run

First, export your Neuralwatt API key so the `docker run` command below can pick it up:

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

Then start the container:

```bash
docker run -d \
  --name open-webui \
  --restart unless-stopped \
  -p 3000:8080 \
  -v open-webui:/app/backend/data \
  -e OPENAI_API_BASE_URL="https://api.neuralwatt.com/v1" \
  -e OPENAI_API_KEY="$NEURALWATT_API_KEY" \
  -e ENABLE_OLLAMA_API=false \
  ghcr.io/open-webui/open-webui:main
```

What each flag does:

- `-p 3000:8080`: Open WebUI listens on `8080` inside the container, exposed on `localhost:3000`.
- `-v open-webui:/app/backend/data`: named volume so chats, accounts, and settings survive container restarts.
- `OPENAI_API_BASE_URL` / `OPENAI_API_KEY`: Neuralwatt as the upstream provider.
- `ENABLE_OLLAMA_API=false`: disables the bundled Ollama integration so the model list shows only Neuralwatt.

## First-Run Setup

1. Open `http://localhost:3000`.
2. Create the first user. This account becomes the admin.
3. Open the model picker at the top of the chat view. You should see the full Neuralwatt catalog (Kimi K2.5/2.6, Qwen3.5/3.6, GLM-5.1, Devstral, gpt-oss, etc.).
4. Pick a model and send a message.

If models don't appear, check **Admin Panel → Settings → Connections** and confirm the OpenAI base URL and key match what you passed in.

## Switching Models

- **Per chat:** click the model name at the top of the chat to swap.
- **Multi-model side-by-side:** use the `+` in the model picker to add more models. Responses stream in parallel columns.
- **System default:** Admin Panel → Settings → Models. Can also be set at startup with `-e DEFAULT_MODELS="Qwen/Qwen3.5-397B-A17B-FP8"`.
- **Per-user default:** user Settings → Interface → Default Model.

## Available Models

Browse the catalog at [portal.neuralwatt.com](https://portal.neuralwatt.com), or query the API directly:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

New Neuralwatt models show up after a page refresh. Open WebUI re-fetches `/v1/models` on demand rather than caching indefinitely.

## Updating

```bash
docker pull ghcr.io/open-webui/open-webui:main
docker rm -f open-webui
# re-run the docker run command above
```

The `open-webui` named volume is preserved across recreates, so accounts and chat history stay intact.

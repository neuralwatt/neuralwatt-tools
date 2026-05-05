# Crush with Neuralwatt

[Crush](https://github.com/charmbracelet/crush) is a terminal-based AI coding assistant from [Charm](https://charm.sh) that supports multiple LLM providers, mid-session model switching, LSP integration, and MCP extensibility. It discovers providers from environment variables automatically, so if `NEURALWATT_API_KEY` is set, Neuralwatt models appear with no configuration.

![Crush model selection with Neuralwatt](../../images/crush-model-selection.png)

## Prerequisites

- [Neuralwatt API key](https://portal.neuralwatt.com)

## Install

```bash
# Homebrew (macOS/Linux)
brew install charmbracelet/tap/crush

# Debian/Ubuntu
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://repo.charm.sh/apt/gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/charm.gpg
echo "deb [signed-by=/etc/apt/keyrings/charm.gpg] https://repo.charm.sh/apt/ * *" | sudo tee /etc/apt/sources.list.d/charm.list
sudo apt update && sudo apt install crush

# Fedora/RHEL
echo '[charm]
name=Charm
baseurl=https://repo.charm.sh/yum/
enabled=1
gpgcheck=1
gpgkey=https://repo.charm.sh/yum/gpg.key' | sudo tee /etc/yum.repos.d/charm.repo
sudo yum install crush

# Arch Linux
yay -S crush-bin

# NPM
npm install -g @charmland/crush
```

Binaries, `.deb`, and `.rpm` packages are also available on the [releases page](https://github.com/charmbracelet/crush/releases).

## Setup

**Export your API key** (add to your shell config, e.g. `~/.zshrc` or `~/.bashrc`):

```bash
export NEURALWATT_API_KEY="your-api-key-here"
```

That's it. Crush detects the key and registers Neuralwatt as a provider automatically.

## Run

```bash
crush
```

## Switch Models

1. Press `/` to open the command menu
2. Select **Switch Models**
3. Filter by "Neuralwatt"
4. Pick a model

You can also set defaults in `~/.config/crush/crush.json`. Crush picks a `large` model for primary work and a `small` one for cheaper background tasks:

```json
{
  "model": {
    "large": "moonshotai/Kimi-K2.6",
    "small": "Qwen/Qwen3.6-35B-A3B"
  }
}
```

## Available Models

Browse the full catalog at [portal.neuralwatt.com](https://portal.neuralwatt.com), or query the API directly:

```bash
curl -s -H "Authorization: Bearer $NEURALWATT_API_KEY" \
  https://api.neuralwatt.com/v1/models | jq '.data[].id'
```

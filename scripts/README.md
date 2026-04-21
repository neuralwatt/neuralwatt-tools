# Scripts

- **nw-usage** — Check your Neuralwatt API usage and energy consumption
- **nw-opencode-config** — Generate OpenCode config from the live Neuralwatt API

---

# nw-usage

## Dependencies

- `curl` - for API requests
- `jq` - for JSON parsing

Both are pre-installed on macOS. On Linux: `apt install curl jq` or equivalent.

## Installation

Add the script to your PATH:

```bash
# Option 1: Symlink (recommended - stays updated with repo)
ln -s /path/to/neuralwatt-tools/scripts/nw-usage ~/.local/bin/nw-usage

# Option 2: Copy
cp /path/to/neuralwatt-tools/scripts/nw-usage ~/.local/bin/
chmod +x ~/.local/bin/nw-usage
```

Make sure `~/.local/bin` is in your PATH (add to `~/.zshrc` if needed):

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## API Key Setup

The script looks for your API key in this order:

1. **Environment variable** (recommended):
   ```bash
   export NEURALWATT_API_KEY="your-api-key-here"
   ```

2. **Default file** at `~/.config/neuralwatt/api_key`:
   ```bash
   mkdir -p ~/.config/neuralwatt
   echo "your-api-key-here" > ~/.config/neuralwatt/api_key
   chmod 600 ~/.config/neuralwatt/api_key
   ```

3. **Custom file path** via `NEURALWATT_API_KEY_FILE`:
   ```bash
   export NEURALWATT_API_KEY_FILE="/path/to/your/keyfile"
   ```

Get your API key from [portal.neuralwatt.com](https://portal.neuralwatt.com).

## Usage

```bash
nw-usage                       # Human-readable output
nw-usage --tmux                # Compact for tmux/statusline (cached)
nw-usage --tmux --color '1;32' # With ANSI color (bright green)
nw-usage --json                # Raw JSON from API
nw-usage --help                # Show help
```

### Examples

**Human-readable** (default):
```
$ nw-usage
Neuralwatt Usage for 2026-01-14
  Requests: 49
  Energy: 3Wh (12469J)
```

**Tmux format** (`--tmux`):
```
$ nw-usage --tmux
↗49 ⚡3Wh
```

**JSON** (`--json`):
```json
{
  "period": {"start": "2025-12-15", "end": "2026-01-14"},
  "totals": {"requests": 1962, "energy_kwh": 0.389, ...},
  "daily": [{"date": "2026-01-14", "requests": 49, ...}, ...]
}
```

## Caching

The `--tmux` flag caches results for 5 minutes at `/tmp/nw-usage-cache.json` to avoid excessive API calls from statusline refreshes. Other modes always fetch fresh data.

## Colors

The `--color` flag accepts ANSI color codes:

| Code | Color |
|------|-------|
| `0;31` | Red |
| `0;32` | Green |
| `0;33` | Yellow |
| `0;34` | Blue |
| `0;36` | Cyan |
| `1;31` | Bright red |
| `1;32` | Bright green |
| `1;33` | Bright yellow |
| `1;36` | Bright cyan |

## Integrations

- **Claude Code statusline**: See [recipes/claude-code/](../recipes/claude-code/)
- **Tmux statusline**: See [recipes/tmux/](../recipes/tmux/)
- **OpenCode**: See [recipes/opencode/](../recipes/opencode/)

---

# nw-opencode-config

Generate an [OpenCode](https://opencode.ai) config for Neuralwatt from the live API.

## Dependencies

- `curl` - for API requests
- `jq` - for JSON parsing and config merging

## Installation

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-opencode-config ~/.local/bin/
```

## Usage

```bash
nw-opencode-config                        # Print config to stdout
nw-opencode-config --write                # Write to ~/.config/opencode/opencode.json
nw-opencode-config --models-only          # Print just the models block
nw-opencode-config --list                 # List available models
nw-opencode-config --include-aliases      # Include alias/fast models
nw-opencode-config --default MODEL_ID     # Set default model
```

### How it works

1. Fetches model IDs and context limits from `https://api.neuralwatt.com/v1/models`
2. Merges with curated metadata (`opencode-models.json`) for display names, output limits, and model-specific options
3. Outputs a valid `opencode.json` — context limits from the API, output limits from metadata

### Config merging

Re-running `--write` refreshes the Neuralwatt model list to match the current API. The script distinguishes facts it owns from opinions the user owns:

| Field | Behavior on re-run |
|-|-|
| `provider.neuralwatt.models` | Replaced wholesale (stale models removed) |
| `provider.neuralwatt.options` (baseURL, apiKey) | Deep-merged; existing values win |
| `.model` | Preserved; only set when `--default` passed or field is missing |
| `command.nw-usage` | Preserved if already defined; added if missing |
| Other providers, commands, top-level keys | Untouched |

### Default model

First `--write` sets the default to `Qwen/Qwen3.5-397B-A17B-FP8`. Subsequent runs leave `.model` alone unless you pass `--default`:

```bash
nw-opencode-config --write --default zai-org/GLM-5.1-FP8
```

`--default` is validated against the live API — typos fail fast instead of producing a broken config.

### Updating

When new models are added to the Neuralwatt API, re-run to update your config:

```bash
nw-opencode-config --write
```

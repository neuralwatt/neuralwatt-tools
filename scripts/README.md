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

Print an [OpenCode](https://opencode.ai) config for Neuralwatt to stdout, generated from the live API. **Never writes to your config file** — you redirect the output yourself.

## Dependencies

- `curl` - for API requests
- `jq` - for JSON generation

## Installation

```bash
ln -s /path/to/neuralwatt-tools/scripts/nw-opencode-config ~/.local/bin/
```

## Usage

```bash
nw-opencode-config                        # Full opencode.json to stdout
nw-opencode-config --models-only          # Just the models block
nw-opencode-config --list                 # List available models (human-readable)
nw-opencode-config --include-aliases      # Include alias/fast models
nw-opencode-config --default MODEL_ID     # Override default in output
```

### How it works

1. Fetches model IDs and context limits from `https://api.neuralwatt.com/v1/models`
2. Merges with curated metadata (`opencode-models.json`) for display names, output limits, and model-specific options
3. Prints a valid `opencode.json` to stdout

### Writing the output

Fresh install — redirect directly:

```bash
nw-opencode-config > ~/.config/opencode/opencode.json
```

Existing config — generate the models block and merge by hand:

```bash
nw-opencode-config --models-only | pbcopy
# then paste under provider.neuralwatt.models in your existing config
```

The script deliberately does not touch your config file. That keeps it a pure generator with no merge logic to go wrong.

### Default model

Defaults to `Qwen/Qwen3.5-397B-A17B-FP8`. Override with `--default`:

```bash
nw-opencode-config --default zai-org/GLM-5.1-FP8 > opencode.json
```

`--default` is validated against the live API — typos fail fast.

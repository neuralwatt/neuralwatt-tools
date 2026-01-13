# nw-usage

CLI for checking your NeuralWatt API usage and energy consumption.

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
nw-usage           # Human-readable output
nw-usage --tmux    # Compact for tmux statusline (cached)
nw-usage --json    # Raw JSON from API
nw-usage --help    # Show help
```

### Examples

**Human-readable** (default):
```
$ nw-usage
NeuralWatt Usage for 2026-01-14
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

## Integrations

- **Tmux statusline**: See [recipes/tmux/](../recipes/tmux/)
- **OpenCode**: See [recipes/opencode/](../recipes/opencode/)

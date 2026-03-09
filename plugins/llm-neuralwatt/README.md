# llm-neuralwatt

A plugin for [LLM](https://llm.datasette.io/) that adds support for [Neuralwatt](https://neuralwatt.com) models with **energy usage tracking**.

![llm chat with energy metrics](../../images/llm-chat-energy.png)

This plugin captures the energy consumption metadata that Neuralwatt returns with each inference request, storing it in LLM's log database alongside token usage.

## Installation

Install directly from GitHub:

```bash
llm install "llm-neuralwatt @ git+https://github.com/neuralwatt/neuralwatt-tools.git#subdirectory=plugins/llm-neuralwatt"
```

Or install from a local clone (run from the repo root):

```bash
llm install -e plugins/llm-neuralwatt
```

## Configuration

Set your Neuralwatt API key:

```bash
llm keys set neuralwatt
# paste your API key
```

## Available Models

Models are discovered automatically from the Neuralwatt API at startup. Run `llm models | grep neuralwatt` to see what's available. Model IDs are derived from the API names, e.g. `Qwen/Qwen3.5-397B-A17B-FP8` becomes `neuralwatt-qwen3.5-397b-a17b-fp8`.

If the API is unreachable (no key set, network down), a small set of fallback models is registered instead.

## Usage

```bash
llm -m neuralwatt-qwen3.5-397b-a17b-fp8 "Explain what a monad is"
```

### Show Energy After Response

Pass `-o show_energy true` to print energy and performance stats after each response:

```bash
llm -m neuralwatt-qwen3.5-397b-a17b-fp8 "What is a closure?" -o show_energy true
```

```
A closure is a function that captures variables from its enclosing scope...

⚡ 45.20J | 58.00W | 0.78s | 12.60mWh | 84.3 tok/s | TTFT 261ms
```

### Chat Mode

Energy is shown after each assistant message:

```bash
llm chat -m neuralwatt-kimi-k2.5 -o show_energy true
```

```
> What's a hashmap?
A Hashmap is a data structure that implements an associative array,
mapping keys to values. It uses hash functions to compute an index
where values are stored, enabling fast O(1) average-case lookups...

⚡ 1.10kJ | 126.40W | 8.69s | 305.12mWh | 52.1 tok/s | TTFT 185ms

> What about a binary search tree?
A Binary Search Tree (BST) is a node-based data structure where the
left subtree contains only nodes with keys less than the parent, and
the right subtree contains only nodes with keys greater...

⚡ 2.81kJ | 260.20W | 17.70s | 780.75mWh | 61.4 tok/s | TTFT 203ms
```

Energy and perf stats go to stderr so they don't become part of the conversation history. Longer responses consume more energy (the BST explanation used ~2.5x the energy of the hashmap answer).

### Unit Scaling

All units auto-scale with SI prefixes to keep values readable:

| Range | Prefix | Example |
|-------|--------|---------|
| >= 1M | M | 1.50MJ |
| >= 1k | k | 1.50kW |
| >= 1 | (none) | 45.20J |
| >= 0.001 | m | 12.60mWh |
| >= 0.000001 | u | 5.00uWh |

## Energy Logging

Energy data is always logged to llm's database, even without `show_energy`:

```bash
llm logs -n 1 --json | python3 -c "
import sys, json
d = json.load(sys.stdin)[0]
e = d.get('response_json', {}).get('energy', {})
print(f'Energy: {e.get(\"energy_joules\", 0):.2f} J')
print(f'Power:  {e.get(\"avg_power_watts\", 0):.1f} W')
print(f'Time:   {e.get(\"duration_seconds\", 0):.3f} s')
"
```

### Energy Fields

| Field | Description |
|-------|-------------|
| `energy_joules` | Total energy consumed for this request |
| `energy_kwh` | Energy in kilowatt-hours |
| `avg_power_watts` | Average GPU power during inference |
| `duration_seconds` | Inference duration |
| `attribution_method` | How energy was attributed (e.g., "prorated") |
| `attribution_ratio` | Fraction of GPU time attributed to this request |

## Why Energy Tracking?

Every inference request uses real energy. Neuralwatt measures it per-request and returns the data in the API response. This plugin logs that data so you can see your cumulative energy use over time and compare efficiency across models.

## Development

Set up a local development environment:

```bash
python -m venv venv
source venv/bin/activate
python -m pip install -e '.[test]'
```

Run the tests:

```bash
python -m pytest
```

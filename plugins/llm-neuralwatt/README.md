# llm-neuralwatt

A plugin for [LLM](https://llm.datasette.io/) that adds support for [NeuralWatt](https://neuralwatt.com) models with **energy usage tracking**.

![llm chat with energy metrics](../../images/llm-chat-energy.png)

This plugin captures the energy consumption metadata that NeuralWatt returns with each inference request, storing it in LLM's log database alongside token usage.

## Installation

Clone this repo and install from source:

```bash
git clone https://github.com/neuralwatt/neuralwatt-tools.git
llm install -e neuralwatt-tools/plugins/llm-neuralwatt
```

Or if you already have the repo:

```bash
llm install -e /path/to/neuralwatt-tools/plugins/llm-neuralwatt
```

## Configuration

Set your NeuralWatt API key:

```bash
llm keys set neuralwatt
# paste your API key
```

## Available Models

- `neuralwatt-qwen` - Qwen/Qwen3-Coder-480B-A35B-Instruct
- `neuralwatt-deepseek` - deepseek-ai/deepseek-coder-33b-instruct
- `neuralwatt-gpt-oss` - openai/gpt-oss-20b

## Usage

```bash
llm -m neuralwatt-qwen "Explain what a monad is"
```

### Show Energy After Response

Display energy usage after each response with `-o show_energy true`:

```bash
llm -m neuralwatt-qwen "What is a closure?" -o show_energy true
```

```
A closure is a function that captures variables from its enclosing scope...

⚡ 45.20J | 58.00W | 0.78s | 12.60mWh
```

### Chat Mode

Energy is shown after each assistant message:

```bash
llm chat -m neuralwatt-deepseek -o show_energy true
```

```
> What's a hashmap?
A Hashmap is a data structure that implements an associative array,
mapping keys to values. It uses hash functions to compute an index
where values are stored, enabling fast O(1) average-case lookups...

⚡ 1.10kJ | 126.40W | 8.69s | 305.12mWh

> What about a binary search tree?
A Binary Search Tree (BST) is a node-based data structure where the
left subtree contains only nodes with keys less than the parent, and
the right subtree contains only nodes with keys greater...

⚡ 2.81kJ | 260.20W | 17.70s | 780.75mWh
```

Energy is printed to stderr so it doesn't pollute the response or conversation history.
Longer responses consume more energy—the BST explanation used ~2.5x the energy of the hashmap answer.

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

NeuralWatt provides transparency into the environmental cost of AI inference. By logging energy data alongside responses, you can track cumulative energy use over time, compare efficiency across models, and build awareness of AI's carbon footprint.

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

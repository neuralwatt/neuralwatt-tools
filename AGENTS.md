# Agent Guide: neuralwatt-tools

This repository contains tools, plugins, and recipes for the Neuralwatt inference API.

## Project Structure

```
neuralwatt-tools/
├── plugins/llm-neuralwatt/   # Python pip-installable LLM plugin
├── scripts/                   # Shell scripts (nw-usage)
├── recipes/                   # Configuration guides for various tools
└── .github/workflows/         # CI configuration
```

---

## Build/Lint/Test Commands

### Python (plugins/llm-neuralwatt)

```bash
# Install with dev dependencies
pip install -e './plugins/llm-neuralwatt[test]'

# Run all tests
python -m pytest plugins/llm-neuralwatt/tests/

# Run a single test file
python -m pytest plugins/llm-neuralwatt/tests/test_llm_neuralwatt.py

# Run a single test function
python -m pytest plugins/llm-neuralwatt/tests/test_llm_neuralwatt.py::test_format_scaled

# Run tests matching a pattern
python -m pytest plugins/llm-neuralwatt/tests/ -k "energy"

# Lint and format
ruff check .
ruff format --check .

# Auto-fix
ruff check --fix . && ruff format .
```

### Shell Scripts

```bash
shellcheck scripts/*
```

---

## Code Style Guidelines

### Python (3.10+)

**Imports**: Group and order as: stdlib → third-party → local. Separate groups with blank lines.

```python
import json
import logging
from typing import Iterator, Optional

import click
import httpx
import llm
from pydantic import Field
```

**Formatting**: Line length 100, double quotes, 4-space indent (enforced by ruff).

**Naming**:
- `snake_case` for functions, variables, modules
- `PascalCase` for classes
- `UPPER_SNAKE_CASE` for constants
- Private methods: prefix with underscore (`_build_messages`)

**Type Hints**: Use Python 3.10+ syntax.

```python
def fetch_models(api_key: str) -> dict[str, str]:
def compute_perf(usage: Optional[dict], energy: Optional[dict]) -> dict:
```

**Error Handling**: Use `llm.ModelError` for plugin errors.

```python
if r.status_code != 200:
    raise llm.ModelError(f"Neuralwatt API error {r.status_code}: {r.text}")
```

**Logging**: Use module-level logger.

```python
logger = logging.getLogger(__name__)
logger.warning("Neuralwatt model discovery failed. Using fallback models.")
```

**Class Design**: Use Pydantic `Field` for options with validation.

```python
class NeuralwattChat(llm.Model):
    needs_key = "neuralwatt"
    key_env_var = "NEURALWATT_API_KEY"
    can_stream = True

    class Options(llm.Options):
        temperature: Optional[float] = Field(
            default=None, description="Sampling temperature", ge=0.0, le=2.0
        )
```

---

### Shell Scripts (Bash)

```bash
#!/bin/bash
# Description of what the script does
set -euo pipefail

if [[ -z "$api_key" ]]; then
    echo "Error: No API key found. Set NEURALWATT_API_KEY" >&2
    exit 1
fi
```

---

## Testing

**Naming**: `test_<function>_<scenario>` pattern.

```python
def test_fetch_models_success(httpx_mock):
def test_fetch_models_http_error(httpx_mock):
```

**Parametrized Tests**:

```python
@pytest.mark.parametrize("value,unit,expected", [
    (1_500_000, "J", "1.50MJ"),
    (45.2, "J", "45.20J"),
])
def test_format_scaled(value, unit, expected):
    assert format_scaled(value, unit) == expected
```

**HTTP Mocking**: Use `pytest-httpx`.

```python
def test_fetch_models_success(httpx_mock):
    httpx_mock.add_response(method="GET", url="...", json={"data": [...]})
```

---

## CI/CD

CI runs on push to main and PRs:
1. **test**: pytest on Python 3.10, 3.11, 3.12, 3.13
2. **lint**: `ruff check` and `ruff format --check`
3. **shellcheck**: Lints shell scripts in `scripts/`

---

## Key Dependencies

- `llm` - Simon Willison's LLM CLI framework (plugin system)
- `httpx` - HTTP client for API requests
- `pydantic` - Data validation via Field
- `pytest` + `pytest-httpx` - Testing

"""
LLM plugin for Neuralwatt API with energy usage tracking.

This plugin provides access to Neuralwatt's inference API and captures
energy consumption metadata that Neuralwatt returns with each request.
"""

import json
import logging
import re
import time
from typing import Iterator, Optional

import click
import httpx
import llm
from pydantic import Field

logger = logging.getLogger(__name__)

# API configuration
API_BASE = "https://api.neuralwatt.com/v1"
USER_AGENT = "llm-neuralwatt/0.1.0"
TIMEOUT_SECONDS = 300.0
DISCOVERY_TIMEOUT_SECONDS = 5.0

# Fallback models used when the /v1/models endpoint is unreachable.
FALLBACK_MODELS = {
    "neuralwatt-qwen": "Qwen/Qwen3.5-397B-A17B-FP8",
    "neuralwatt-kimi": "moonshotai/Kimi-K2.5",
    "neuralwatt-gpt-oss": "openai/gpt-oss-20b",
}


def model_id_from_name(api_model_id: str) -> str:
    """Derive a short llm model ID from a Neuralwatt API model name.

    Examples:
        "Qwen/Qwen3.5-397B-A17B-FP8" -> "neuralwatt-qwen3.5-397b-a17b-fp8"
        "moonshotai/Kimi-K2.5" -> "neuralwatt-kimi-k2.5"
        "openai/gpt-oss-20b" -> "neuralwatt-gpt-oss-20b"
        "mistralai/Devstral-Small-2-24B-Instruct-2512" -> "neuralwatt-devstral-small-2-24b-instruct-2512"
    """
    # Use the part after the org prefix (or the whole string if no slash).
    name = api_model_id.split("/", 1)[-1]
    # Strip common suffixes that add noise.
    name = re.sub(r"[-_](instruct|chat|base)$", "", name, flags=re.IGNORECASE)
    # Lowercase, collapse whitespace/underscores to hyphens.
    name = re.sub(r"[_\s]+", "-", name).lower()
    return f"neuralwatt-{name}"


def fetch_models(api_key: str) -> dict[str, str]:
    """Fetch available models from the Neuralwatt /v1/models endpoint.

    Returns a dict mapping llm model IDs to API model names.
    """
    headers = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": USER_AGENT,
    }
    with httpx.Client(timeout=DISCOVERY_TIMEOUT_SECONDS) as client:
        r = client.get(f"{API_BASE}/models", headers=headers)
        r.raise_for_status()

    models = {}
    for entry in r.json().get("data", []):
        api_name = entry["id"]
        model_id = model_id_from_name(api_name)
        models[model_id] = api_name
    return models


def format_scaled(value: float, unit: str) -> str:
    """Format a value with auto-scaled SI prefix."""
    if value >= 1_000_000:
        return f"{value / 1_000_000:.2f}M{unit}"
    elif value >= 1_000:
        return f"{value / 1_000:.2f}k{unit}"
    elif value >= 1:
        return f"{value:.2f}{unit}"
    elif value >= 0.001:
        return f"{value * 1_000:.2f}m{unit}"
    elif value >= 0.000001:
        return f"{value * 1_000_000:.2f}u{unit}"
    else:
        return f"0{unit}"


def print_stats(energy: dict, perf: dict) -> None:
    """Print energy and performance stats to stderr."""
    joules = energy.get("energy_joules", 0)
    watts = energy.get("avg_power_watts", 0)
    duration = energy.get("duration_seconds", 0)
    wh = energy.get("energy_kwh", 0) * 1000

    parts = [
        format_scaled(joules, "J"),
        format_scaled(watts, "W"),
        f"{duration:.2f}s",
        format_scaled(wh, "Wh"),
    ]

    tok_s = perf.get("output_tok_s")
    if tok_s is not None:
        parts.append(f"{tok_s:.1f} tok/s")

    ttft_ms = perf.get("ttft_ms")
    if ttft_ms is not None:
        parts.append(f"TTFT {ttft_ms:.0f}ms")

    # Show TFAT only when it differs from TTFT (i.e. model used thinking).
    tfat_ms = perf.get("tfat_ms")
    if tfat_ms is not None and ttft_ms is not None and tfat_ms != ttft_ms:
        parts.append(f"TFAT {tfat_ms:.0f}ms")

    reasoning_tokens = perf.get("reasoning_tokens")
    if reasoning_tokens:
        parts.append(f"{reasoning_tokens} thinking")

    line = f"⚡ {' | '.join(parts)}"
    click.echo(f"\n{click.style(line, fg='green')}", err=True)


def compute_perf(
    usage: Optional[dict],
    energy: Optional[dict],
    ttft_ms: Optional[float],
    tfat_ms: Optional[float] = None,
    reasoning_tokens: int = 0,
) -> dict:
    """Compute performance metrics from usage, energy, and client-side timing.

    Args:
        ttft_ms: Time to first token (reasoning or content, whichever comes first).
        tfat_ms: Time to first answer token (first visible content token).
                 Only differs from ttft_ms when the model uses thinking.
        reasoning_tokens: Number of reasoning tokens counted during streaming.
            When > 0, tok/s is based on visible content tokens only.
    """
    perf = {}
    if ttft_ms is not None:
        perf["ttft_ms"] = ttft_ms
    if tfat_ms is not None:
        perf["tfat_ms"] = tfat_ms

    completion_tokens = (usage or {}).get("completion_tokens")
    duration = (energy or {}).get("duration_seconds")
    if completion_tokens and duration and duration > 0:
        visible_tokens = completion_tokens - reasoning_tokens
        perf["output_tok_s"] = visible_tokens / duration

    if reasoning_tokens > 0:
        perf["reasoning_tokens"] = reasoning_tokens

    return perf


class NeuralwattChat(llm.Model):
    """Neuralwatt chat completion model with energy tracking."""

    needs_key = "neuralwatt"
    key_env_var = "NEURALWATT_API_KEY"
    can_stream = True

    class Options(llm.Options):
        temperature: Optional[float] = Field(
            default=None, description="Sampling temperature (0.0 to 2.0)", ge=0.0, le=2.0
        )
        max_tokens: Optional[int] = Field(
            default=None, description="Maximum tokens to generate", ge=1
        )
        top_p: Optional[float] = Field(
            default=None, description="Nucleus sampling threshold", ge=0.0, le=1.0
        )
        show_energy: Optional[bool] = Field(
            default=None, description="Display energy usage after response"
        )

    def __init__(self, model_id: str, model_name: str):
        self.model_id = model_id
        self._model_name = model_name

    def execute(
        self,
        prompt: llm.Prompt,
        stream: bool,
        response: llm.Response,
        conversation: Optional[llm.Conversation] = None,
    ) -> Iterator[str]:
        """Execute the model and yield response chunks."""
        headers = {
            "Authorization": f"Bearer {self.get_key()}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        }
        body = {
            "model": self._model_name,
            "messages": self._build_messages(prompt, conversation),
            "stream": stream,
        }
        if prompt.options.temperature is not None:
            body["temperature"] = prompt.options.temperature
        if prompt.options.max_tokens is not None:
            body["max_tokens"] = prompt.options.max_tokens
        if prompt.options.top_p is not None:
            body["top_p"] = prompt.options.top_p

        if stream:
            yield from self._stream(headers, body, response, prompt.options.show_energy)
        else:
            yield from self._fetch(headers, body, response, prompt.options.show_energy)

    def _build_messages(self, prompt: llm.Prompt, conversation: Optional[llm.Conversation]) -> list:
        """Build the messages array for the API request."""
        messages = []

        if conversation:
            for resp in conversation.responses:
                messages.append({"role": "user", "content": resp.prompt.prompt})
                messages.append({"role": "assistant", "content": resp.text()})

        if prompt.system:
            messages.insert(0, {"role": "system", "content": prompt.system})

        messages.append({"role": "user", "content": prompt.prompt})
        return messages

    def _fetch(
        self, headers: dict, body: dict, response: llm.Response, show_energy: bool
    ) -> Iterator[str]:
        """Execute a non-streaming request."""
        with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
            r = client.post(f"{API_BASE}/chat/completions", headers=headers, json=body)
            if r.status_code != 200:
                raise llm.ModelError(f"Neuralwatt API error {r.status_code}: {r.text}")
            data = r.json()

        content = data["choices"][0]["message"]["content"]
        usage = data.get("usage")
        energy = data.get("energy")
        # No TTFT for non-streaming — the client gets everything at once.
        perf = compute_perf(usage, energy, ttft_ms=None)

        response.response_json = {
            "id": data.get("id"),
            "model": data.get("model"),
            "usage": usage,
            "energy": energy,
            "perf": perf,
        }

        yield content
        if show_energy and energy:
            print_stats(energy, perf)

    def _stream(
        self, headers: dict, body: dict, response: llm.Response, show_energy: bool
    ) -> Iterator[str]:
        """Execute a streaming request (SSE)."""
        usage = None
        energy = None
        chunk_id = None
        t_first_any = None
        t_first_content = None
        reasoning_token_count = 0

        with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
            t_start = time.monotonic()
            with client.stream(
                "POST", f"{API_BASE}/chat/completions", headers=headers, json=body
            ) as r:
                if r.status_code != 200:
                    raise llm.ModelError(
                        f"Neuralwatt API error {r.status_code}: {r.read().decode()}"
                    )

                buffer = ""
                for text in r.iter_text():
                    buffer += text
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue

                        # Neuralwatt sends energy as SSE comment: ": energy {...}"
                        if line.startswith(": energy "):
                            try:
                                energy = json.loads(line[9:])
                            except json.JSONDecodeError:
                                pass
                            continue

                        if not line.startswith("data: "):
                            continue

                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break

                        try:
                            chunk = json.loads(data_str)
                        except json.JSONDecodeError:
                            continue

                        chunk_id = chunk.get("id") or chunk_id
                        if chunk.get("usage"):
                            usage = chunk["usage"]
                        if chunk.get("energy"):
                            energy = chunk["energy"]

                        if chunk.get("choices"):
                            delta = chunk["choices"][0].get("delta", {})
                            # Count reasoning tokens (delta.reasoning / delta.reasoning_content).
                            if delta.get("reasoning") or delta.get("reasoning_content"):
                                reasoning_token_count += 1
                                if t_first_any is None:
                                    t_first_any = time.monotonic()
                            content = delta.get("content", "")
                            if content:
                                if t_first_any is None:
                                    t_first_any = time.monotonic()
                                if t_first_content is None:
                                    t_first_content = time.monotonic()
                                yield content

        # TTFT: first token of any kind (reasoning or content).
        ttft_ms = (t_first_any - t_start) * 1000 if t_first_any else None
        # TFAT: first visible content token (only set when model used thinking).
        tfat_ms = None
        if reasoning_token_count > 0 and t_first_content:
            tfat_ms = (t_first_content - t_start) * 1000
        perf = compute_perf(usage, energy, ttft_ms, tfat_ms, reasoning_token_count)

        response.response_json = {
            "id": chunk_id,
            "model": self._model_name,
            "usage": usage,
            "energy": energy,
            "perf": perf,
        }

        if show_energy and energy:
            print_stats(energy, perf)


@llm.hookimpl
def register_models(register):
    """Register Neuralwatt models, discovering them from the API when possible."""
    models = None
    key = llm.get_key("", "neuralwatt", "NEURALWATT_API_KEY")
    if key:
        try:
            models = fetch_models(key)
        except httpx.HTTPStatusError as exc:
            logger.warning(
                "Neuralwatt model discovery failed (HTTP %s). Using fallback models.",
                exc.response.status_code,
            )
        except httpx.ConnectError:
            logger.debug("Neuralwatt API unreachable. Using fallback models.")

    if not models:
        models = FALLBACK_MODELS

    for model_id, model_name in models.items():
        register(NeuralwattChat(model_id, model_name))

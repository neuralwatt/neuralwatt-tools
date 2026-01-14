"""
LLM plugin for Neuralwatt API with energy usage tracking.

This plugin provides access to Neuralwatt's inference API and captures
energy consumption metadata that Neuralwatt returns with each request.
"""

import json
from typing import Optional, Iterator

import click
import httpx
import llm
from pydantic import Field

# API configuration
API_BASE = "https://api.neuralwatt.com/v1"
USER_AGENT = "llm-neuralwatt/0.1.0"
TIMEOUT_SECONDS = 300.0

# Available models on Neuralwatt
MODELS = {
    "neuralwatt-qwen": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "neuralwatt-deepseek": "deepseek-ai/deepseek-coder-33b-instruct",
    "neuralwatt-gpt-oss": "openai/gpt-oss-20b",
}


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


def print_energy(energy: dict) -> None:
    """Print energy data to stderr (so it doesn't become part of conversation history)."""
    joules = energy.get("energy_joules", 0)
    watts = energy.get("avg_power_watts", 0)
    duration = energy.get("duration_seconds", 0)
    wh = energy.get("energy_kwh", 0) * 1000

    line = f"⚡ {format_scaled(joules, 'J')} | {format_scaled(watts, 'W')} | {duration:.2f}s | {format_scaled(wh, 'Wh')}"
    click.echo(f"\n{click.style(line, fg='green')}", err=True)


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

    def _build_messages(
        self, prompt: llm.Prompt, conversation: Optional[llm.Conversation]
    ) -> list:
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
        energy = data.get("energy")

        response.response_json = {
            "id": data.get("id"),
            "model": data.get("model"),
            "usage": data.get("usage"),
            "energy": energy,
        }

        yield content
        if show_energy and energy:
            print_energy(energy)

    def _stream(
        self, headers: dict, body: dict, response: llm.Response, show_energy: bool
    ) -> Iterator[str]:
        """Execute a streaming request (SSE)."""
        usage = None
        energy = None
        chunk_id = None

        with httpx.Client(timeout=TIMEOUT_SECONDS) as client:
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
                            content = chunk["choices"][0].get("delta", {}).get("content", "")
                            if content:
                                yield content

        response.response_json = {
            "id": chunk_id,
            "model": self._model_name,
            "usage": usage,
            "energy": energy,
        }

        if show_energy and energy:
            print_energy(energy)


@llm.hookimpl
def register_models(register):
    """Register Neuralwatt models."""
    for model_id, model_name in MODELS.items():
        register(NeuralwattChat(model_id, model_name))

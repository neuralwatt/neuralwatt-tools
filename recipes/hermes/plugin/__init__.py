"""Neuralwatt provider profile for Hermes Agent.

Install this directory into ``~/.hermes/plugins/model-providers/neuralwatt/``
(see this recipe's README). It registers Neuralwatt as a first-class Hermes
provider so it shows up in ``hermes status`` and the ``/model`` picker with a
real model catalog, instead of an anonymous "Custom endpoint".

Neuralwatt is OpenAI-compatible, so Hermes live-fetches the model catalog from
``models_url`` (``{base_url}/models``). ``fallback_models`` is only consulted
when that endpoint is unreachable, so the live API is always the source of
truth and this list cannot silently go stale.
"""

from providers import register_provider
from providers.base import ProviderProfile

neuralwatt = ProviderProfile(
    name="neuralwatt",
    aliases=("neural-watt", "neuralwatt-ai"),
    display_name="Neuralwatt",
    description="Neuralwatt — GLM, Kimi, Qwen via OpenAI-compatible API",
    signup_url="https://portal.neuralwatt.com",
    env_vars=("NEURALWATT_API_KEY", "NEURALWATT_BASE_URL"),
    base_url="https://api.neuralwatt.com/v1",
    models_url="https://api.neuralwatt.com/v1/models",
    default_aux_model="glm-5.2-fast",
    # Best-effort fallback only; the live /v1/models endpoint above is the
    # source of truth and overrides this list whenever it is reachable.
    fallback_models=(
        "glm-5.2",
        "glm-5.2-fast",
        "glm-5.2-short",
        "glm-5.2-short-fast",
        "kimi-k2.6",
        "kimi-k2.6-fast",
        "kimi-k2.7-code",
        "qwen3.5-397b",
        "qwen3.5-397b-fast",
        "qwen3.6-35b",
        "qwen3.6-35b-fast",
    ),
)

register_provider(neuralwatt)

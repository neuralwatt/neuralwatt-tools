"""Neuralwatt provider profile for Hermes Agent.

Install this directory into ``~/.hermes/plugins/model-providers/neuralwatt/``
(see this recipe's README). It registers Neuralwatt as a first-class Hermes
provider so it shows up in ``hermes status`` and the ``/model`` picker with a
real model catalog, instead of an anonymous "Custom endpoint".

Neuralwatt is OpenAI-compatible, so Hermes live-fetches the model *catalog*
(the ``/model`` picker list) from ``{base_url}/models``. The live API is the
source of truth there, so the picker can't silently go stale. We deliberately
do not set ``models_url``: leaving it unset lets ``fetch_models()`` honor a
``NEURALWATT_BASE_URL`` override (it derives the catalog endpoint from the
effective base URL), so chat and the catalog can't point at different hosts.

Two IDs are *not* covered by that live fetch and are pinned here / in the
recipe README: ``default_aux_model`` below, and the README's ``config.yaml``
``model.default``. Both exist in the live catalog today; if either is ever
retired upstream, refresh it here (aux) and in the README (default).

``fallback_models`` is consulted only when the live catalog fetch
(``{base_url}/models``) is unreachable. It is intentionally the public
(unauthenticated) ``/v1/models`` set — the standard
tiers. Flex variants and any enrollment-gated models are deliberately omitted
from this fallback; they still appear in the live picker for keys that can see
them, so this gap is not drift to "fix".
"""

from providers import register_provider
from providers.base import ProviderProfile

neuralwatt = ProviderProfile(
    name="neuralwatt",
    aliases=("neural", "neural-watt", "neuralwatt-ai"),
    display_name="Neuralwatt",
    description="Neuralwatt — GLM, Kimi, Qwen via OpenAI-compatible API",
    signup_url="https://portal.neuralwatt.com",
    env_vars=("NEURALWATT_API_KEY", "NEURALWATT_BASE_URL"),
    base_url="https://api.neuralwatt.com/v1",
    default_aux_model="glm-5.2-fast",
    # Best-effort offline fallback only; the live {base_url}/models endpoint is
    # the source of truth and overrides this list whenever it is reachable.
    # This is the public (unauthenticated) catalog — standard tiers, no flex.
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

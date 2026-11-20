# Hermes Agent with Neuralwatt

The setup guide for Hermes Agent is in the Neuralwatt docs: [Hermes Agent](https://docs.neuralwatt.com/integrations/hermes).

If you set Hermes up with an older version of this recipe, remove `OPENAI_API_KEY` and `OPENAI_BASE_URL` from `~/.hermes/.env` if they point at Neuralwatt. Leaving `OPENAI_BASE_URL` set can send Hermes' OpenAI and OpenRouter fallbacks to the wrong endpoint.

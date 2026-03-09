"""Tests for llm-neuralwatt plugin."""

from unittest.mock import Mock, patch

import httpx
import llm
import pytest
from llm_neuralwatt import (
    FALLBACK_MODELS,
    NeuralwattChat,
    compute_perf,
    fetch_models,
    format_scaled,
    model_id_from_name,
    print_stats,
    register_models,
)

# --- Unit tests for format_scaled ---


@pytest.mark.parametrize(
    "value,unit,expected",
    [
        # Mega
        (1_500_000, "J", "1.50MJ"),
        (2_000_000, "W", "2.00MW"),
        # Kilo
        (1_500, "J", "1.50kJ"),
        (1_000, "W", "1.00kW"),
        # Base
        (45.2, "J", "45.20J"),
        (100, "W", "100.00W"),
        (1, "Wh", "1.00Wh"),
        # Milli
        (0.5, "J", "500.00mJ"),
        (0.0126, "Wh", "12.60mWh"),
        # Micro
        (0.000005, "Wh", "5.00uWh"),
        (0.000001, "J", "1.00uJ"),
        # Zero
        (0, "J", "0J"),
        (0.0000000001, "Wh", "0Wh"),
    ],
)
def test_format_scaled(value, unit, expected):
    assert format_scaled(value, unit) == expected


# --- Unit tests for print_stats ---


def test_print_stats_energy_only(capsys):
    """Energy-only output when no perf metrics are available."""
    energy = {
        "energy_joules": 45.2,
        "avg_power_watts": 55.7,
        "duration_seconds": 0.81,
        "energy_kwh": 0.0000126,
    }
    print_stats(energy, {})
    captured = capsys.readouterr()
    assert "⚡" in captured.err
    assert "45.20J" in captured.err
    assert "55.70W" in captured.err
    assert "0.81s" in captured.err
    assert "12.60mWh" in captured.err
    assert "tok/s" not in captured.err
    assert "TTFT" not in captured.err


def test_print_stats_with_perf(capsys):
    """Output includes tok/s and TTFT when perf metrics are present."""
    energy = {
        "energy_joules": 10,
        "avg_power_watts": 50,
        "duration_seconds": 0.5,
        "energy_kwh": 2.7e-06,
    }
    perf = {"output_tok_s": 42.3, "ttft_ms": 312.5}
    print_stats(energy, perf)
    captured = capsys.readouterr()
    assert "42.3 tok/s" in captured.err
    assert "TTFT 312ms" in captured.err
    # No thinking, so TFAT should not appear.
    assert "TFAT" not in captured.err
    assert "thinking" not in captured.err


def test_print_stats_with_reasoning(capsys):
    """Output shows TTFT, TFAT, and reasoning count when model used thinking."""
    energy = {
        "energy_joules": 10,
        "avg_power_watts": 50,
        "duration_seconds": 1.0,
        "energy_kwh": 2.7e-06,
    }
    perf = {"output_tok_s": 10.0, "ttft_ms": 50.0, "tfat_ms": 500.0, "reasoning_tokens": 87}
    print_stats(energy, perf)
    captured = capsys.readouterr()
    assert "10.0 tok/s" in captured.err
    assert "TTFT 50ms" in captured.err
    assert "TFAT 500ms" in captured.err
    assert "87 thinking" in captured.err


def test_print_stats_tfat_hidden_when_equal_to_ttft(capsys):
    """TFAT is not shown when it equals TTFT (no thinking happened)."""
    energy = {
        "energy_joules": 10,
        "avg_power_watts": 50,
        "duration_seconds": 0.5,
        "energy_kwh": 2.7e-06,
    }
    perf = {"output_tok_s": 20.0, "ttft_ms": 200.0, "tfat_ms": 200.0}
    print_stats(energy, perf)
    captured = capsys.readouterr()
    assert "TTFT 200ms" in captured.err
    assert "TFAT" not in captured.err


# --- Unit tests for compute_perf ---


def test_compute_perf_with_all_data():
    usage = {"completion_tokens": 100}
    energy = {"duration_seconds": 2.0}
    perf = compute_perf(usage, energy, ttft_ms=250.0)
    assert perf["output_tok_s"] == 50.0
    assert perf["ttft_ms"] == 250.0
    assert "tfat_ms" not in perf
    assert "reasoning_tokens" not in perf


def test_compute_perf_with_reasoning_tokens():
    """tok/s uses visible tokens only (completion - reasoning)."""
    usage = {"completion_tokens": 100}
    energy = {"duration_seconds": 2.0}
    perf = compute_perf(usage, energy, ttft_ms=50.0, tfat_ms=500.0, reasoning_tokens=80)
    # (100 - 80) / 2.0 = 10.0 visible tok/s
    assert perf["output_tok_s"] == 10.0
    assert perf["ttft_ms"] == 50.0
    assert perf["tfat_ms"] == 500.0
    assert perf["reasoning_tokens"] == 80


def test_compute_perf_missing_usage():
    """tok/s is omitted when usage data is unavailable."""
    perf = compute_perf(None, {"duration_seconds": 1.0}, ttft_ms=100.0)
    assert "output_tok_s" not in perf
    assert perf["ttft_ms"] == 100.0


def test_compute_perf_missing_ttft():
    """TTFT is omitted when not measured (e.g. empty response)."""
    usage = {"completion_tokens": 50}
    energy = {"duration_seconds": 1.0}
    perf = compute_perf(usage, energy, ttft_ms=None)
    assert perf["output_tok_s"] == 50.0
    assert "ttft_ms" not in perf


def test_compute_perf_zero_duration():
    """tok/s is omitted when duration is zero to avoid division by zero."""
    usage = {"completion_tokens": 10}
    energy = {"duration_seconds": 0}
    perf = compute_perf(usage, energy, ttft_ms=50.0)
    assert "output_tok_s" not in perf


# --- model_id_from_name tests ---


@pytest.mark.parametrize(
    "api_id,expected",
    [
        ("Qwen/Qwen3.5-397B-A17B-FP8", "neuralwatt-qwen3.5-397b-a17b-fp8"),
        ("moonshotai/Kimi-K2.5", "neuralwatt-kimi-k2.5"),
        ("openai/gpt-oss-20b", "neuralwatt-gpt-oss-20b"),
        ("mistralai/Devstral-Small-2-24B-Instruct-2512", "neuralwatt-devstral-small-2-24b-instruct-2512"),
        ("Qwen/Qwen3.5-35B-A3B", "neuralwatt-qwen3.5-35b-a3b"),
        ("some-model-chat", "neuralwatt-some-model-chat"),
        ("org/Model_Name-Base", "neuralwatt-model-name-base"),
    ],
)
def test_model_id_from_name(api_id, expected):
    assert model_id_from_name(api_id) == expected


# --- fetch_models tests ---


def test_fetch_models_success(httpx_mock):
    """Dynamic discovery returns models from the API."""
    httpx_mock.add_response(
        method="GET",
        url="https://api.neuralwatt.com/v1/models",
        json={
            "object": "list",
            "data": [
                {"id": "Qwen/Qwen3.5-397B-A17B-FP8", "object": "model"},
                {"id": "moonshotai/Kimi-K2.5", "object": "model"},
            ],
        },
    )

    models = fetch_models("test-key")
    assert len(models) == 2
    assert "neuralwatt-qwen3.5-397b-a17b-fp8" in models
    assert models["neuralwatt-qwen3.5-397b-a17b-fp8"] == "Qwen/Qwen3.5-397B-A17B-FP8"
    assert "neuralwatt-kimi-k2.5" in models


def test_fetch_models_http_error(httpx_mock):
    """fetch_models raises on non-200 responses."""
    httpx_mock.add_response(
        method="GET",
        url="https://api.neuralwatt.com/v1/models",
        status_code=401,
    )

    with pytest.raises(Exception):
        fetch_models("bad-key")


# --- Model registration tests ---


def test_register_models_dynamic(httpx_mock):
    """register_models uses API discovery when available."""
    httpx_mock.add_response(
        method="GET",
        url="https://api.neuralwatt.com/v1/models",
        json={
            "object": "list",
            "data": [
                {"id": "Qwen/Qwen3.5-397B-A17B-FP8", "object": "model"},
                {"id": "moonshotai/Kimi-K2.5", "object": "model"},
            ],
        },
    )

    registered = []
    with patch("llm_neuralwatt.llm.get_key", return_value="test-key"):
        register_models(registered.append)

    model_ids = {m.model_id for m in registered}
    assert "neuralwatt-qwen3.5-397b-a17b-fp8" in model_ids
    assert "neuralwatt-kimi-k2.5" in model_ids


def test_register_models_fallback_on_no_key():
    """Falls back to hardcoded models when no API key is set."""
    registered = []
    with patch("llm_neuralwatt.llm.get_key", return_value=""):
        register_models(registered.append)

    model_ids = {m.model_id for m in registered}
    assert model_ids == set(FALLBACK_MODELS.keys())


def test_register_models_fallback_on_connect_error():
    """Falls back to hardcoded models when the API is unreachable."""
    registered = []
    with (
        patch("llm_neuralwatt.llm.get_key", return_value="test-key"),
        patch(
            "llm_neuralwatt.fetch_models",
            side_effect=httpx.ConnectError("connection refused"),
        ),
    ):
        register_models(registered.append)

    model_ids = {m.model_id for m in registered}
    assert model_ids == set(FALLBACK_MODELS.keys())


def test_register_models_fallback_on_timeout():
    """Falls back to hardcoded models when the API times out."""
    registered = []
    with (
        patch("llm_neuralwatt.llm.get_key", return_value="test-key"),
        patch(
            "llm_neuralwatt.fetch_models",
            side_effect=httpx.TimeoutException("timed out"),
        ),
    ):
        register_models(registered.append)

    model_ids = {m.model_id for m in registered}
    assert model_ids == set(FALLBACK_MODELS.keys())


def test_register_models_fallback_on_auth_error(caplog):
    """Falls back with a warning when the API returns an auth error."""
    mock_response = Mock()
    mock_response.status_code = 401
    registered = []
    with (
        patch("llm_neuralwatt.llm.get_key", return_value="bad-key"),
        patch(
            "llm_neuralwatt.fetch_models",
            side_effect=httpx.HTTPStatusError(
                "Unauthorized", request=Mock(), response=mock_response
            ),
        ),
    ):
        register_models(registered.append)

    model_ids = {m.model_id for m in registered}
    assert model_ids == set(FALLBACK_MODELS.keys())
    assert "HTTP 401" in caplog.text


def test_model_attributes():
    """Verify model has correct attributes."""
    model = NeuralwattChat("neuralwatt-qwen", "Qwen/Qwen3.5-397B-A17B-FP8")

    assert model.model_id == "neuralwatt-qwen"
    assert model._model_name == "Qwen/Qwen3.5-397B-A17B-FP8"
    assert model.needs_key == "neuralwatt"
    assert model.can_stream is True


# --- HTTP request tests ---


def test_fetch_captures_energy(httpx_mock):
    """Test non-streaming request captures energy data."""
    mock_response = {
        "id": "chatcmpl-123",
        "model": "test-model",
        "choices": [{"message": {"content": "Hello!"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        "energy": {
            "energy_joules": 27.3,
            "energy_kwh": 7.583e-06,
            "avg_power_watts": 55.7,
            "duration_seconds": 0.49,
        },
    }

    httpx_mock.add_response(
        method="POST",
        url="https://api.neuralwatt.com/v1/chat/completions",
        json=mock_response,
    )

    model = NeuralwattChat("test", "test-model")

    # Mock get_key
    with patch.object(model, "get_key", return_value="test-key"):
        prompt = Mock()
        prompt.prompt = "Hello"
        prompt.system = None
        prompt.options = Mock()
        prompt.options.temperature = None
        prompt.options.max_tokens = None
        prompt.options.top_p = None
        prompt.options.show_energy = False

        response = Mock()
        response.response_json = None

        result = list(model.execute(prompt, stream=False, response=response))

    assert result == ["Hello!"]
    assert response.response_json["energy"]["energy_joules"] == 27.3
    assert response.response_json["usage"]["total_tokens"] == 15
    # 5 completion tokens / 0.49s ≈ 10.2 tok/s
    assert response.response_json["perf"]["output_tok_s"] == pytest.approx(10.2, abs=0.1)
    # Non-streaming: no TTFT (client gets everything at once).
    assert "ttft_ms" not in response.response_json["perf"]


def test_stream_captures_energy(httpx_mock):
    """Test streaming request captures energy from SSE comment."""
    # SSE response with energy as comment
    sse_response = (
        'data: {"id":"123","choices":[{"delta":{"role":"assistant"}}]}\n\n'
        'data: {"id":"123","choices":[{"delta":{"content":"Hello"}}]}\n\n'
        'data: {"id":"123","choices":[{"delta":{"content":"!"}}]}\n\n'
        'data: {"id":"123","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
        ": energy "
        '{"energy_joules":30.5,"energy_kwh":8.5e-06,"avg_power_watts":60.0,"duration_seconds":0.51}\n\n'
        "data: [DONE]\n\n"
    )

    httpx_mock.add_response(
        method="POST",
        url="https://api.neuralwatt.com/v1/chat/completions",
        content=sse_response.encode(),
        headers={"content-type": "text/event-stream"},
    )

    model = NeuralwattChat("test", "test-model")

    with patch.object(model, "get_key", return_value="test-key"):
        prompt = Mock()
        prompt.prompt = "Hi"
        prompt.system = None
        prompt.options = Mock()
        prompt.options.temperature = None
        prompt.options.max_tokens = None
        prompt.options.top_p = None
        prompt.options.show_energy = False

        response = Mock()
        response.response_json = None

        result = list(model.execute(prompt, stream=True, response=response))

    assert result == ["Hello", "!"]
    assert response.response_json["energy"]["energy_joules"] == 30.5
    assert response.response_json["energy"]["avg_power_watts"] == 60.0
    # 2 completion tokens / 0.51s ≈ 3.9 tok/s
    assert response.response_json["perf"]["output_tok_s"] == pytest.approx(3.9, abs=0.1)
    assert response.response_json["perf"]["ttft_ms"] > 0
    # No reasoning tokens, so no TFAT.
    assert "tfat_ms" not in response.response_json["perf"]


def test_stream_with_reasoning_tokens(httpx_mock):
    """Streaming response with reasoning tokens reports accurate visible tok/s."""
    # Simulate: 3 reasoning chunks, then 2 content chunks.
    sse_response = (
        'data: {"id":"r1","choices":[{"delta":{"role":"assistant"}}]}\n\n'
        'data: {"id":"r1","choices":[{"delta":{"reasoning":"The","reasoning_content":"The"}}]}\n\n'
        'data: {"id":"r1","choices":[{"delta":{"reasoning":" answer","reasoning_content":" answer"}}]}\n\n'
        'data: {"id":"r1","choices":[{"delta":{"reasoning":" is","reasoning_content":" is"}}]}\n\n'
        'data: {"id":"r1","choices":[{"delta":{"content":"555"}}]}\n\n'
        'data: {"id":"r1","choices":[{"delta":{"content":"."}}]}\n\n'
        'data: {"id":"r1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'
        ": energy "
        '{"energy_joules":10.0,"energy_kwh":2.7e-06,"avg_power_watts":50.0,"duration_seconds":1.0}\n\n'
        "data: [DONE]\n\n"
    )

    httpx_mock.add_response(
        method="POST",
        url="https://api.neuralwatt.com/v1/chat/completions",
        content=sse_response.encode(),
        headers={"content-type": "text/event-stream"},
    )

    model = NeuralwattChat("test", "test-model")

    with patch.object(model, "get_key", return_value="test-key"):
        prompt = Mock()
        prompt.prompt = "What is 15*37?"
        prompt.system = None
        prompt.options = Mock()
        prompt.options.temperature = None
        prompt.options.max_tokens = None
        prompt.options.top_p = None
        prompt.options.show_energy = False

        response = Mock()
        response.response_json = None

        result = list(model.execute(prompt, stream=True, response=response))

    # Only content tokens are yielded to the user.
    assert result == ["555", "."]
    perf = response.response_json["perf"]
    assert perf["reasoning_tokens"] == 3
    # Visible tok/s: (5 total - 3 reasoning) / 1.0s = 2.0
    assert perf["output_tok_s"] == 2.0
    # TTFT should be earlier (first reasoning token).
    assert perf["ttft_ms"] > 0
    # TFAT should be later (first content token, after reasoning).
    assert perf["tfat_ms"] > 0
    assert perf["tfat_ms"] >= perf["ttft_ms"]


def test_build_messages_with_conversation():
    """Test message building includes conversation history."""
    model = NeuralwattChat("test", "test-model")

    prompt = Mock()
    prompt.prompt = "What about now?"
    prompt.system = "You are helpful."

    # Mock conversation with one prior exchange
    prior_response = Mock()
    prior_response.prompt = Mock()
    prior_response.prompt.prompt = "Hello"
    prior_response.text = Mock(return_value="Hi there!")

    conversation = Mock()
    conversation.responses = [prior_response]

    messages = model._build_messages(prompt, conversation)

    assert len(messages) == 4
    assert messages[0] == {"role": "system", "content": "You are helpful."}
    assert messages[1] == {"role": "user", "content": "Hello"}
    assert messages[2] == {"role": "assistant", "content": "Hi there!"}
    assert messages[3] == {"role": "user", "content": "What about now?"}


def test_show_energy_prints_to_stderr(httpx_mock, capsys):
    """Test that show_energy option prints energy and perf stats to stderr."""
    mock_response = {
        "id": "123",
        "model": "test",
        "choices": [{"message": {"content": "Hi"}}],
        "usage": {"prompt_tokens": 5, "completion_tokens": 20, "total_tokens": 25},
        "energy": {
            "energy_joules": 10,
            "energy_kwh": 2.7e-06,
            "avg_power_watts": 50,
            "duration_seconds": 0.5,
        },
    }

    httpx_mock.add_response(
        method="POST",
        url="https://api.neuralwatt.com/v1/chat/completions",
        json=mock_response,
    )

    model = NeuralwattChat("test", "test-model")

    with patch.object(model, "get_key", return_value="test-key"):
        prompt = Mock()
        prompt.prompt = "Hi"
        prompt.system = None
        prompt.options = Mock()
        prompt.options.temperature = None
        prompt.options.max_tokens = None
        prompt.options.top_p = None
        prompt.options.show_energy = True  # Enable energy display

        response = Mock()
        response.response_json = None

        list(model.execute(prompt, stream=False, response=response))

    captured = capsys.readouterr()
    assert "⚡" in captured.err
    assert "10.00J" in captured.err
    assert "tok/s" in captured.err
    # Non-streaming: no TTFT in output.
    assert "TTFT" not in captured.err


def test_api_error_raises_model_error(httpx_mock):
    """Test that API errors raise llm.ModelError."""
    httpx_mock.add_response(
        method="POST",
        url="https://api.neuralwatt.com/v1/chat/completions",
        status_code=401,
        text="Unauthorized",
    )

    model = NeuralwattChat("test", "test-model")

    with patch.object(model, "get_key", return_value="bad-key"):
        prompt = Mock()
        prompt.prompt = "Hi"
        prompt.system = None
        prompt.options = Mock()
        prompt.options.temperature = None
        prompt.options.max_tokens = None
        prompt.options.top_p = None
        prompt.options.show_energy = False

        response = Mock()

        with pytest.raises(llm.ModelError) as exc_info:
            list(model.execute(prompt, stream=False, response=response))

        assert "401" in str(exc_info.value)

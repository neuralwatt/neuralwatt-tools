"""Tests for llm-neuralwatt plugin."""

from unittest.mock import Mock, patch

import llm
import pytest
from llm_neuralwatt import (
    NeuralwattChat,
    format_scaled,
    print_energy,
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


# --- Unit tests for print_energy ---


def test_print_energy_output(capsys):
    energy = {
        "energy_joules": 45.2,
        "avg_power_watts": 55.7,
        "duration_seconds": 0.81,
        "energy_kwh": 0.0000126,
    }
    print_energy(energy)
    captured = capsys.readouterr()
    assert "⚡" in captured.err
    assert "45.20J" in captured.err
    assert "55.70W" in captured.err
    assert "0.81s" in captured.err
    assert "12.60mWh" in captured.err


# --- Model registration tests ---


def test_models_registered():
    """Verify all models are registered with llm."""
    registered = []
    register_models(registered.append)

    assert len(registered) == 3
    model_ids = {m.model_id for m in registered}
    assert model_ids == {"neuralwatt-qwen", "neuralwatt-deepseek", "neuralwatt-gpt-oss"}


def test_model_attributes():
    """Verify model has correct attributes."""
    model = NeuralwattChat("neuralwatt-qwen", "Qwen/Qwen3-Coder-480B-A35B-Instruct")

    assert model.model_id == "neuralwatt-qwen"
    assert model._model_name == "Qwen/Qwen3-Coder-480B-A35B-Instruct"
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
    """Test that show_energy option prints to stderr."""
    mock_response = {
        "id": "123",
        "model": "test",
        "choices": [{"message": {"content": "Hi"}}],
        "usage": {"total_tokens": 5},
        "energy": {
            "energy_joules": 10,
            "energy_kwh": 2.7e-06,
            "avg_power_watts": 50,
            "duration_seconds": 0.2,
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

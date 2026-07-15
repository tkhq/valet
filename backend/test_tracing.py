"""Tests for the backend tracing helpers. No network: spans go to an in-memory exporter."""

from __future__ import annotations

import pytest

import tracing

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
SPAN_ID = "b7ad6b7169203331"


@pytest.fixture(autouse=True)
def reset_tracing():
    tracing._reset()
    yield
    tracing._reset()


def _memory_provider():
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider, exporter


def test_span_is_noop_when_endpoint_unset(monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    with tracing.span("modal.test", "00-" + TRACE_ID + "-" + SPAN_ID + "-01") as s:
        assert s is None
    tracing.flush()  # must not raise


def test_span_is_noop_when_endpoint_blank(monkeypatch):
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "   ")
    with tracing.span("modal.test") as s:
        assert s is None


def test_traceparent_produces_parented_span():
    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with tracing.span("modal.test", f"00-{TRACE_ID}-{SPAN_ID}-01", {"sandbox_id": "sb-1"}) as s:
        assert s is not None

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    span = spans[0]
    assert format(span.context.trace_id, "032x") == TRACE_ID
    assert span.parent is not None
    assert format(span.parent.span_id, "016x") == SPAN_ID
    assert span.parent.is_remote is True
    assert span.attributes["sandbox_id"] == "sb-1"


def test_malformed_traceparent_does_not_raise():
    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    non_hex_trace_id = f"00-{'z' * 32}-{SPAN_ID}-01"
    for bad in ("garbage", "00-abc-def-01", non_hex_trace_id):
        with tracing.span("modal.test", bad) as s:
            assert s is not None

    for span in exporter.get_finished_spans():
        assert span.parent is None


def test_body_exception_is_recorded_and_reraised():
    from opentelemetry.trace import StatusCode

    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with pytest.raises(RuntimeError, match="boom"):
        with tracing.span("modal.test"):
            raise RuntimeError("boom")

    span = exporter.get_finished_spans()[0]
    assert span.status.status_code == StatusCode.ERROR
    # Class name only — the raw message must never reach the span.
    assert span.attributes["error.class"] == "RuntimeError"
    assert span.status.description == "RuntimeError"
    assert not span.events
    serialized = repr((span.attributes, span.status.description, span.events))
    assert "boom" not in serialized


def test_parse_otlp_headers():
    assert tracing.parse_otlp_headers("a=b,c=d") == {"a": "b", "c": "d"}
    assert tracing.parse_otlp_headers(" k = v ,bad, =x") == {"k": "v"}
    assert tracing.parse_otlp_headers("token=abc=def") == {"token": "abc=def"}
    assert tracing.parse_otlp_headers(None) == {}
    assert tracing.parse_otlp_headers("") == {}

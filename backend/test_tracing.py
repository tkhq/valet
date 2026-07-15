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


def test_unsampled_traceparent_starts_fresh_sampled_root():
    # flags 00: inheriting the unsampled parent would make the parent-based
    # sampler drop every backend span — expect a fresh root instead.
    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with tracing.span("modal.test", f"00-{TRACE_ID}-{SPAN_ID}-00") as s:
        assert s is not None

    span = exporter.get_finished_spans()[0]
    assert span.parent is None
    assert format(span.context.trace_id, "032x") != TRACE_ID
    assert span.context.trace_flags.sampled is True


def test_nested_spans_parent_to_the_enclosing_span():
    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with tracing.span("modal.outer") as outer:
        with tracing.span("modal.inner") as inner:
            assert inner is not None
        assert outer is not None

    finished = {s.name: s for s in exporter.get_finished_spans()}
    outer_ctx = finished["modal.outer"].context
    inner_span = finished["modal.inner"]
    assert inner_span.parent is not None
    assert inner_span.parent.span_id == outer_ctx.span_id
    assert inner_span.context.trace_id == outer_ctx.trace_id


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


def test_handled_exception_marked_via_mark_error():
    from opentelemetry.trace import StatusCode

    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with tracing.span("modal.test") as s:
        try:
            raise ValueError("sensitive detail")
        except ValueError as exc:
            tracing.mark_error(s, exc)

    span = exporter.get_finished_spans()[0]
    assert span.status.status_code == StatusCode.ERROR
    assert span.attributes["error.class"] == "ValueError"
    assert "sensitive detail" not in repr((span.attributes, span.status.description))
    tracing.mark_error(None, ValueError("x"))  # no-op span must not raise


def test_attributes_are_stringified_and_truncated():
    provider, exporter = _memory_provider()
    tracing._init(provider=provider)

    with tracing.span("modal.test", None, {"sandbox_id": {"nested": "x" * 500}, "n": 42}):
        pass

    span = exporter.get_finished_spans()[0]
    assert len(span.attributes["sandbox_id"]) == 128
    assert span.attributes["n"] == "42"


def test_parse_otlp_headers():
    assert tracing.parse_otlp_headers("a=b,c=d") == {"a": "b", "c": "d"}
    assert tracing.parse_otlp_headers(" k = v ,bad, =x") == {"k": "v"}
    assert tracing.parse_otlp_headers("token=abc=def") == {"token": "abc=def"}
    # Percent-encoded values (Grafana Cloud's documented Authorization form) decode.
    assert tracing.parse_otlp_headers("Authorization=Basic%20dXNlcjp0b2tlbg==") == {
        "Authorization": "Basic dXNlcjp0b2tlbg=="
    }
    assert tracing.parse_otlp_headers(None) == {}
    assert tracing.parse_otlp_headers("") == {}


def test_env_driven_init_builds_exporter_from_env(monkeypatch):
    captured: dict = {}

    class FakeExporter:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def export(self, spans):
            from opentelemetry.sdk.trace.export import SpanExportResult

            return SpanExportResult.SUCCESS

        def shutdown(self):
            pass

        def force_flush(self, timeout_millis: int = 30_000):
            return True

    monkeypatch.setattr(
        "opentelemetry.exporter.otlp.proto.http.trace_exporter.OTLPSpanExporter",
        FakeExporter,
    )
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://tempo.example/")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_HEADERS", "Authorization=Basic%20xyz,k=v")
    monkeypatch.setenv("MODAL_APP_NAME", "dev-valet-backend")

    tracing._init()

    assert captured["endpoint"] == "https://tempo.example/v1/traces"
    assert captured["headers"] == {"Authorization": "Basic xyz", "k": "v"}
    assert tracing._provider is not None
    resource = tracing._provider.resource
    assert resource.attributes["service.name"] == "dev-valet-backend"
    tracing._provider.shutdown()

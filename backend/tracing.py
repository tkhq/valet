"""OpenTelemetry tracing for the Modal backend.

Ships dark: a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set (delivered via a
deploy-time Modal secret, see app.py). Every path is exception-safe — tracing
failures degrade to no-op spans and must never break an endpoint, so OTel
imports stay lazy and guarded.

Export cadence: spans flush on the BatchSpanProcessor schedule (5s default in
SDK 1.43) and on interpreter exit — TracerProvider defaults shutdown_on_exit=True,
which registers an atexit shutdown that drains the processor. No per-request
flushing: force_flush blocks the event loop for up to its timeout.
"""

from __future__ import annotations

import logging
import os
from contextlib import contextmanager
from typing import Any, Iterator

logger = logging.getLogger(__name__)

_provider: Any = None
_tracer: Any = None
_init_done = False


def parse_otlp_headers(raw: str | None) -> dict[str, str]:
    """Parse the OTLP `k=v,k2=v2` header convention into a header dict.

    Values are percent-decoded per the OTLP env spec — Grafana Cloud documents
    the `Authorization=Basic%20<token>` form.
    """
    from urllib.parse import unquote

    headers: dict[str, str] = {}
    if not raw:
        return headers
    for pair in raw.split(","):
        key, eq, value = pair.partition("=")
        key = key.strip()
        if eq and key:
            headers[key] = unquote(value.strip())
    return headers


def _init(provider: Any = None) -> None:
    """Initialise the tracer once per process.

    `provider` is a test seam: pass a pre-built TracerProvider (e.g. with an
    in-memory exporter) to bypass the env-driven OTLP setup.
    """
    global _provider, _tracer, _init_done
    if provider is not None:
        _provider = provider
        _tracer = provider.get_tracer("valet-backend")
        _init_done = True
        return
    if _init_done:
        return
    _init_done = True
    try:
        endpoint = (os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
        if not endpoint:
            return  # unset/blank endpoint → tracing stays off
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        exporter = OTLPSpanExporter(
            endpoint=f"{endpoint.rstrip('/')}/v1/traces",
            headers=parse_otlp_headers(os.environ.get("OTEL_EXPORTER_OTLP_HEADERS")),
        )
        # `or`, not a .get default: the deploy-time secret may set MODAL_APP_NAME to "".
        tracer_provider = TracerProvider(
            resource=Resource.create(
                {"service.name": os.environ.get("MODAL_APP_NAME") or "valet-backend"}
            )
        )
        tracer_provider.add_span_processor(BatchSpanProcessor(exporter))
        _provider = tracer_provider
        _tracer = tracer_provider.get_tracer("valet-backend")
    except Exception:
        logger.warning("OTel tracer init failed; continuing without tracing", exc_info=True)
        _provider = None
        _tracer = None


def _reset() -> None:
    """Test seam: forget any initialised tracer so env changes take effect."""
    global _provider, _tracer, _init_done
    _provider = None
    _tracer = None
    _init_done = False


def _parent_context(traceparent: str | None) -> Any:
    """OTel Context parented to a W3C traceparent string, or None when absent/malformed."""
    if not traceparent:
        return None
    try:
        from opentelemetry import trace as trace_api
        from opentelemetry.trace import NonRecordingSpan, SpanContext, TraceFlags

        # traceparent = version "-" trace-id(32 hex) "-" span-id(16 hex) "-" flags(2 hex)
        parts = traceparent.strip().split("-")
        if len(parts) < 4 or len(parts[1]) != 32 or len(parts[2]) != 16:
            return None
        # An unsampled parent (flags bit 0 unset) would make the default
        # parent-based sampler drop every backend span. Start a fresh sampled
        # root instead of silently inheriting the drop decision.
        if not int(parts[3], 16) & 1:
            return None
        span_context = SpanContext(
            trace_id=int(parts[1], 16),
            span_id=int(parts[2], 16),
            is_remote=True,
            trace_flags=TraceFlags(TraceFlags.SAMPLED),
        )
        return trace_api.set_span_in_context(NonRecordingSpan(span_context))
    except Exception:
        return None


_MAX_ATTR_LENGTH = 128


def _sanitize_attributes(attributes: dict[str, Any] | None) -> dict[str, str] | None:
    """Coerce attribute values to bounded strings.

    Endpoint attributes come from request bodies on public endpoints, so cap
    what an attacker can push onto a span: str() + truncate to 128 chars.
    """
    if not attributes:
        return None
    try:
        return {
            str(key)[:_MAX_ATTR_LENGTH]: str(value)[:_MAX_ATTR_LENGTH]
            for key, value in attributes.items()
        }
    except Exception:
        return None


def mark_error(span_obj: Any, exc: BaseException) -> None:
    """Mark a handled exception on a span (class name only, no message).

    For endpoints that catch an exception and return a structured error
    response — the span would otherwise end looking successful.
    """
    if span_obj is None:
        return
    try:
        from opentelemetry.trace import Status, StatusCode

        span_obj.set_attribute("error.class", type(exc).__name__)
        span_obj.set_status(Status(StatusCode.ERROR, type(exc).__name__))
    except Exception:
        pass


@contextmanager
def span(
    name: str,
    traceparent: str | None = None,
    attributes: dict[str, Any] | None = None,
) -> Iterator[Any]:
    """Run the body inside a span parented to the caller's traceparent.

    Yields the OTel span, or None when tracing is off or setup failed — the
    body always runs either way. Body exceptions are recorded on the span,
    marked ERROR, and re-raised. Attributes must be identifiers only
    (sandbox_id, session_id) — never env values, request bodies, or errors.
    """
    try:
        _init()
        tracer = _tracer
    except Exception:
        tracer = None
    if tracer is None:
        yield None
        return

    try:
        from opentelemetry import context as context_api, trace as trace_api
        from opentelemetry.trace import Status, StatusCode

        otel_span = tracer.start_span(
            name,
            context=_parent_context(traceparent),
            attributes=_sanitize_attributes(attributes),
        )
        token = context_api.attach(trace_api.set_span_in_context(otel_span))
    except Exception:
        logger.warning("failed to start span %s; continuing untraced", name, exc_info=True)
        yield None
        return

    try:
        yield otel_span
    except BaseException as exc:
        # Class name only — exception messages can carry request/backend text,
        # and the fixed-classification rule keeps raw strings off spans.
        try:
            otel_span.set_attribute("error.class", type(exc).__name__)
            otel_span.set_status(Status(StatusCode.ERROR, type(exc).__name__))
        except Exception:
            pass
        raise
    finally:
        try:
            context_api.detach(token)
        except Exception:
            pass
        try:
            otel_span.end()
        except Exception:
            pass


def flush() -> None:
    """Drain buffered spans synchronously. Test helper — production relies on
    the batch schedule + the provider's atexit shutdown (see module docstring)."""
    try:
        if _provider is not None:
            _provider.force_flush(timeout_millis=2_000)
    except Exception:
        pass

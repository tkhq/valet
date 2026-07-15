from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import tracing
from config import MAX_TIMEOUT_SECONDS
from sandboxes import (
    SandboxAlreadyFinishedError,
    SandboxConfig,
    SandboxManager,
    SandboxSnapshotFailedError,
)


class ConflictError(Exception):
    """Duck-typed stand-in for Modal's already-finished conflict error.

    `_is_already_finished_error` keys off the class name plus message, so a
    plain exception named ConflictError exercises the normal idle-timeout path
    without depending on the Modal SDK's exact exception type.
    """


class _FakeTunnels:
    async def aio(self) -> dict:
        return {}


class _FakeSandbox:
    object_id = "sb-test"
    tunnels = _FakeTunnels()


def _config() -> SandboxConfig:
    return SandboxConfig(
        session_id="session-1",
        user_id="user-1",
        workspace="test",
        do_ws_url="wss://worker/runner",
        runner_token="token",
        jwt_secret="jwt",
        idle_timeout_seconds=900,
    )


class SandboxManagerCreateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = SandboxManager(app=object())
        self.manager._get_image = lambda _image_type: object()  # type: ignore[method-assign]

    async def test_create_sandbox_does_not_set_modal_idle_timeout(self) -> None:
        create = AsyncMock(return_value=_FakeSandbox())

        with (
            patch("sandboxes.modal.Sandbox.create.aio", create),
            patch("sandboxes.modal.Secret.from_dict", return_value=SimpleNamespace()),
            patch("sandboxes.modal.Volume.from_name", return_value=SimpleNamespace()),
        ):
            await self.manager.create_sandbox(_config())

        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["timeout"], MAX_TIMEOUT_SECONDS)
        self.assertNotIn("idle_timeout", kwargs)

    async def test_restore_sandbox_does_not_set_modal_idle_timeout(self) -> None:
        create = AsyncMock(return_value=_FakeSandbox())

        with (
            patch("sandboxes.modal.Sandbox.create.aio", create),
            patch("sandboxes.modal.Image.from_id", return_value=object()),
            patch("sandboxes.modal.Secret.from_dict", return_value=SimpleNamespace()),
            patch("sandboxes.modal.Volume.from_name", return_value=SimpleNamespace()),
        ):
            await self.manager.restore_sandbox(_config(), "im-snapshot")

        kwargs = create.await_args.kwargs
        self.assertEqual(kwargs["timeout"], MAX_TIMEOUT_SECONDS)
        self.assertNotIn("idle_timeout", kwargs)


def _memory_provider():
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    return provider, exporter


class SnapshotSpanTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.manager = SandboxManager(app=object())
        self.provider, self.exporter = _memory_provider()
        tracing._init(provider=self.provider)

    async def asyncTearDown(self) -> None:
        tracing._reset()

    def _snapshot_span(self):
        spans = {s.name: s for s in self.exporter.get_finished_spans()}
        self.assertIn("modal.sandbox.snapshot", spans)
        return spans["modal.sandbox.snapshot"]

    async def test_idle_timeout_snapshot_does_not_mark_span_error(self) -> None:
        from opentelemetry.trace import StatusCode

        sandbox = SimpleNamespace(
            snapshot_filesystem=SimpleNamespace(
                aio=AsyncMock(side_effect=ConflictError("Sandbox has already finished")),
            ),
            terminate=SimpleNamespace(aio=AsyncMock()),
        )

        with patch("sandboxes.modal.Sandbox.from_id.aio", AsyncMock(return_value=sandbox)):
            with self.assertRaises(SandboxAlreadyFinishedError):
                await self.manager.snapshot_and_terminate("sb-1")

        # The normal idle-timeout hibernation must leave the snapshot span un-errored.
        self.assertNotEqual(self._snapshot_span().status.status_code, StatusCode.ERROR)

    async def test_genuine_snapshot_failure_marks_span_error(self) -> None:
        from opentelemetry.trace import StatusCode

        sandbox = SimpleNamespace(
            snapshot_filesystem=SimpleNamespace(
                aio=AsyncMock(side_effect=RuntimeError("Failed to create image")),
            ),
            terminate=SimpleNamespace(aio=AsyncMock()),
        )

        with patch("sandboxes.modal.Sandbox.from_id.aio", AsyncMock(return_value=sandbox)):
            with self.assertRaises(SandboxSnapshotFailedError):
                await self.manager.snapshot_and_terminate("sb-1")

        self.assertEqual(self._snapshot_span().status.status_code, StatusCode.ERROR)


if __name__ == "__main__":
    unittest.main()

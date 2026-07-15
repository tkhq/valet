"""Valet Modal backend — web endpoints for session/sandbox management."""

from __future__ import annotations

import os

import modal
from fastapi import Header

import tracing
from config import WHISPER_MODELS_MOUNT, WHISPER_MODELS_VOLUME

app = modal.App(os.environ.get("MODAL_APP_NAME", "valet-backend"))

# Label prefix isolates endpoint subdomains per environment within a workspace.
# Set via MODAL_LABEL_PREFIX env var (e.g. "prod-", "dev-"). Default: no prefix.
_label_prefix = os.environ.get("MODAL_LABEL_PREFIX", "")

# OTel config captured at deploy time from the deploy shell env (same pattern as
# MODAL_APP_NAME / MODAL_LABEL_PREFIX above) and attached to every endpoint
# function. A Modal secret, not image env: OTEL_EXPORTER_OTLP_HEADERS carries the
# OTLP auth token. Unset at deploy → empty → tracing no-ops (ships dark).
_otel_secret = modal.Secret.from_dict({
    "OTEL_EXPORTER_OTLP_ENDPOINT": os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", ""),
    "OTEL_EXPORTER_OTLP_HEADERS": os.environ.get("OTEL_EXPORTER_OTLP_HEADERS", ""),
    "MODAL_APP_NAME": os.environ.get("MODAL_APP_NAME", ""),
})

# Image for the web functions — includes our backend Python modules
# Also mount runner package and docker files so sandbox image builds can reference them
fn_image = (
    modal.Image.debian_slim()
    .pip_install("fastapi[standard]", "opentelemetry-sdk", "opentelemetry-exporter-otlp-proto-http")
    .add_local_python_source("session", "sandboxes", "config", "images", "tracing")
    .add_local_dir("docker", remote_path="/root/docker", ignore=["**/node_modules"])
    .add_local_dir("packages/runner", remote_path="/root/packages/runner", ignore=["**/node_modules"])
    .add_local_dir("packages/shared", remote_path="/root/packages/shared", ignore=["**/node_modules"])
)

from sandboxes import SandboxAlreadyFinishedError, SandboxSnapshotFailedError
from session import CreateSessionRequest, SessionManager

session_manager = SessionManager(app)


@app.function(image=fn_image, timeout=1800, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}create-session")
async def create_session(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Create a new session and spawn a sandbox.

    Request body:
        sessionId: str
        userId: str
        workspace: str
        imageType: str (default "base")
        doWsUrl: str
        runnerToken: str
        jwtSecret: str
        idleTimeoutSeconds: int (default 900)
        envVars: dict[str, str] (optional)

    Returns:
        sandboxId: str
        tunnelUrls: dict[str, str]
    """
    with tracing.span("modal.create_session", traceparent, {"session_id": request.get("sessionId", "")}):
        req = CreateSessionRequest(
            session_id=request["sessionId"],
            user_id=request["userId"],
            workspace=request["workspace"],
            image_type=request.get("imageType", "base"),
            do_ws_url=request["doWsUrl"],
            runner_token=request["runnerToken"],
            jwt_secret=request["jwtSecret"],
            idle_timeout_seconds=request.get("idleTimeoutSeconds", 900),
            cpu_cores=request.get("sandboxCpuCores"),
            memory_mib=request.get("sandboxMemoryMib"),
            env_vars=request.get("envVars"),
            persona_files=request.get("personaFiles"),
        )

        result = await session_manager.create(req)

        return {
            "sandboxId": result.sandbox_id,
            "tunnelUrls": result.tunnel_urls,
        }


@app.function(image=fn_image, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}terminate-session")
async def terminate_session(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Terminate a session's sandbox.

    Request body:
        sandboxId: str

    Returns:
        success: bool
    """
    with tracing.span("modal.terminate_session", traceparent, {"sandbox_id": request.get("sandboxId", "")}):
        sandbox_id = request["sandboxId"]
        await session_manager.terminate(sandbox_id)
        return {"success": True}


@app.function(image=fn_image, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}hibernate-session")
async def hibernate_session(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Hibernate a session by snapshotting the sandbox filesystem and terminating it.

    Request body:
        sandboxId: str

    Returns:
        snapshotImageId: str
    """
    from fastapi.responses import JSONResponse

    with tracing.span("modal.hibernate_session", traceparent, {"sandbox_id": request.get("sandboxId", "")}) as otel_span:
        sandbox_id = request["sandboxId"]
        try:
            snapshot_image_id = await session_manager.hibernate(sandbox_id)
        except SandboxAlreadyFinishedError as exc:
            # Handled here, so the span never sees the raise — mark it ERROR explicitly.
            tracing.mark_error(otel_span, exc)
            return JSONResponse(
                status_code=409,
                content={"error": "sandbox_already_finished", "message": "Sandbox has already exited (idle timeout). Cannot hibernate."},
            )
        except SandboxSnapshotFailedError as exc:
            tracing.mark_error(otel_span, exc)
            return JSONResponse(
                status_code=503,
                content={"error": "snapshot_failed", "message": str(exc)},
            )
        return {"snapshotImageId": snapshot_image_id}


@app.function(image=fn_image, timeout=1800, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}restore-session")
async def restore_session(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Restore a session from a filesystem snapshot.

    Request body:
        sessionId: str
        userId: str
        workspace: str
        imageType: str (default "base")
        doWsUrl: str
        runnerToken: str
        jwtSecret: str
        idleTimeoutSeconds: int (default 900)
        envVars: dict[str, str] (optional)
        snapshotImageId: str

    Returns:
        sandboxId: str
        tunnelUrls: dict[str, str]
    """
    with tracing.span("modal.restore_session", traceparent, {"session_id": request.get("sessionId", "")}):
        req = CreateSessionRequest(
            session_id=request["sessionId"],
            user_id=request["userId"],
            workspace=request["workspace"],
            image_type=request.get("imageType", "base"),
            do_ws_url=request["doWsUrl"],
            runner_token=request["runnerToken"],
            jwt_secret=request["jwtSecret"],
            idle_timeout_seconds=request.get("idleTimeoutSeconds", 900),
            cpu_cores=request.get("sandboxCpuCores"),
            memory_mib=request.get("sandboxMemoryMib"),
            env_vars=request.get("envVars"),
            persona_files=request.get("personaFiles"),
        )

        result = await session_manager.restore(req, request["snapshotImageId"])

        return {
            "sandboxId": result.sandbox_id,
            "tunnelUrls": result.tunnel_urls,
        }


@app.function(image=fn_image, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}session-status")
async def session_status(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Get status of a session's sandbox.

    Request body:
        sandboxId: str

    Returns:
        sandboxId: str
        status: str
    """
    with tracing.span("modal.session_status", traceparent, {"sandbox_id": request.get("sandboxId", "")}):
        sandbox_id = request["sandboxId"]
        return await session_manager.status(sandbox_id)


@app.function(image=fn_image, secrets=[_otel_secret])
@modal.fastapi_endpoint(method="POST", label=f"{_label_prefix}delete-workspace")
async def delete_workspace(request: dict, traceparent: str | None = Header(default=None)) -> dict:
    """Delete a session's persisted workspace volume.

    Request body:
        sessionId: str

    Returns:
        success: bool
        deleted: bool
    """
    with tracing.span("modal.delete_workspace", traceparent, {"session_id": request.get("sessionId", "")}):
        session_id = request["sessionId"]
        deleted = await session_manager.delete_workspace(session_id)
        return {"success": True, "deleted": deleted}


@app.function(
    image=fn_image,
    volumes={WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME, create_if_missing=True)},
    timeout=1800,
)
def setup_whisper_models():
    """Download whisper.cpp GGML models into the shared volume. Run once.

    Usage: modal run backend/app.py::setup_whisper_models
    """
    import urllib.request

    mount = "/models/whisper"
    base_url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
    models = [
        ("ggml-base.en.bin", 142_000_000),
        ("ggml-large-v3.bin", 3_095_000_000),
    ]
    for name, expected_size in models:
        path = f"{mount}/{name}"
        if os.path.exists(path) and os.path.getsize(path) > expected_size * 0.9:
            print(f"Already exists: {name} ({os.path.getsize(path)} bytes)")
            continue
        print(f"Downloading {name}...")
        urllib.request.urlretrieve(f"{base_url}/{name}", path)
        print(f"Downloaded {name} ({os.path.getsize(path)} bytes)")

    modal.Volume.from_name("whisper-models").commit()

#!/usr/bin/env bash
# Valet installer — designed to be piped to bash:
#
#   curl -fsSL https://raw.githubusercontent.com/tkhq/valet/dev-v2/scripts/install.sh | bash
#
# Downloads the prebuilt `valet` binary for this machine from GitHub
# Releases and installs it. Because the download happens via curl (not a
# browser), macOS never sets the com.apple.quarantine attribute, so
# Gatekeeper's bogus "binary is damaged" dialog for our un-notarized
# binaries never appears.
#
# Configuration (env vars):
#   VALET_VERSION      Release tag to install (default: dev-v2-latest, the
#                      rolling build; versioned releases are e.g. v0.1.0).
#   VALET_INSTALL_DIR  Where to put the binary (default: ~/.local/bin).
#
# Non-interactive by design: no prompts (stdin belongs to the pipe).
set -euo pipefail

REPO="tkhq/valet"
TAG="${VALET_VERSION:-dev-v2-latest}"
INSTALL_DIR="${VALET_INSTALL_DIR:-$HOME/.local/bin}"

# Accept "0.1.0" as shorthand for "v0.1.0".
case "$TAG" in
  dev-*|v*) ;;
  [0-9]*) TAG="v${TAG}" ;;
esac

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *)
    echo "error: unsupported OS '$(uname -s)' — Valet ships macOS and Linux binaries." >&2
    echo "       On Windows, run the linux-x64 binary under WSL." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *)
    echo "error: unsupported architecture '$(uname -m)'." >&2
    exit 1
    ;;
esac

asset="valet-${os}-${arch}"
url="https://github.com/${REPO}/releases/download/${TAG}/${asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} (${TAG})..."
if ! curl -fL --progress-bar -o "${tmp}/valet" "$url"; then
  echo "error: download failed: $url" >&2
  echo "       Check that release '${TAG}' exists and has a ${asset} asset:" >&2
  echo "       https://github.com/${REPO}/releases" >&2
  exit 1
fi

chmod +x "${tmp}/valet"

# Sanity-check before installing: the binary must at least run --version.
if ! version="$("${tmp}/valet" --version 2>/dev/null)"; then
  echo "error: downloaded binary failed to execute on this machine." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
mv "${tmp}/valet" "${INSTALL_DIR}/valet"
echo "Installed valet ${version} (${TAG}) to ${INSTALL_DIR}/valet"

case ":$PATH:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo ""
    echo "note: ${INSTALL_DIR} is not on your PATH. Add it, e.g.:"
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

echo ""
echo "Get started:  valet serve"

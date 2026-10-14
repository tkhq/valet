#!/usr/bin/env bash
# Point nix/valet.nix at a published Valet release.
# Usage: nix/update.sh 0.1.0   (the tag is valet/v<version>)
set -euo pipefail
version="${1:?usage: nix/update.sh <version>}"
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gh release download "valet/v${version}" -R tkhq/valet -D "$tmp" \
  -p valet-linux-x64 -p valet-linux-arm64
sri() { printf 'sha256-%s' "$(openssl dgst -sha256 -binary "$1" | base64)"; }
sed -i -E "s/^  version = \".*\";/  version = \"${version}\";/" "$here/valet.nix"
for pair in x64:valet-linux-x64 arm64:valet-linux-arm64; do
  f="$tmp/${pair#*:}"
  sed -i -E "/name = \"${pair#*:}\";/{n;s|hash = \".*\";|hash = \"$(sri "$f")\";|}" "$here/valet.nix"
done
git -C "$here" diff --stat -- valet.nix

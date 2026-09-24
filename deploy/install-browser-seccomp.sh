#!/usr/bin/env bash
set -euo pipefail
# Run on each sandbox node as root, or bake the file into its node image.
if [[ $# != 1 || $1 != /* ]]; then
  echo 'Supply the absolute kubelet seccomp directory. Example: sudo ./deploy/install-browser-seccomp.sh /var/lib/kubelet/seccomp' >&2
  exit 64
fi
browser_repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
browser_destination=$1/valet
install -d -m 0755 "$browser_destination"
install -m 0644 "$browser_repo/packages/sandbox-docker/seccomp/browser.json" "$browser_destination/browser.json"
sha256sum "$browser_destination/browser.json"

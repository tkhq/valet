#!/usr/bin/env bash
# Reject a Kubernetes user namespace that cannot represent RootlessKit's
# complete dockerd subordinate-id range. Do not shorten the range: doing so
# maps nested container identities onto host-sensitive pod identities.
set -euo pipefail

SUBID_START=65536
SUBID_COUNT=65535
SUBID_END=$((SUBID_START + SUBID_COUNT - 1))

map_covers_subids() {
  local map=$1
  awk -v start="$SUBID_START" -v end="$SUBID_END" '
    $1 <= start && $1 + $3 - 1 >= end { found = 1 }
    END { exit !found }
  ' "$map"
}

validate_outer_maps() {
  local uid_map=${1:-/proc/self/uid_map}
  local gid_map=${2:-/proc/self/gid_map}
  local missing=""
  map_covers_subids "$uid_map" || missing="uid"
  map_covers_subids "$gid_map" || missing="${missing:+$missing and }gid"
  if [ -n "$missing" ]; then
    cat >&2 <<EOF
valet: $missing map cannot represent dockerd subordinate IDs $SUBID_START-$SUBID_END.
valet: do not start Docker with a shorter subordinate-id range.
valet: first upgrade default and large sandbox nodes to Kubernetes 1.35.
valet: set userNamespaces.idsPerPod: 131072.
valet: then recreate this sandbox.
EOF
    return 1
  fi
}

main() {
  # Local Docker sandboxes have no outer pod user namespace. Only Kubernetes
  # userns sandboxes need this rollout guard.
  if [ "${VALET_DOCKER_USERNS:-0}" = "1" ]; then
    validate_outer_maps
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi

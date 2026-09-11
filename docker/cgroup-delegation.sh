#!/usr/bin/env bash
# Delegate one cgroup v2 leaf. The parent and its resource limits stay owned
# by mapped root. These wrappers are functions so fake-tree tests can inject them.
set -u

cgroup_chown() { chown "$@"; }
cgroup_stat() { stat -Lc '%u:%g' "$1"; }
cgroup_user_can_write() {
  setpriv --reuid "$1" --regid "$2" --clear-groups test -w "$3"
}
delegation_error() { printf 'Error: %s\n' "$1" >&2; return 1; }

delegate_cgroup_leaf() {
  local root=$1 leaf=$2 user=$3 path controllers uid gid target
  path="$root/$leaf"
  [ -r "$path/cgroup.controllers" ] || delegation_error \
    "Cgroup controllers are unavailable at /sys/fs/cgroup/$leaf. Recreate the sandbox with the valet-docker RuntimeClass." || return 1
  controllers=" $(cat "$path/cgroup.controllers") " || return 1
  for target in cpu pids; do
    case "$controllers" in
      *" $target "*) ;;
      *) delegation_error "The $target cgroup controller is unavailable. Configure the valet-docker RuntimeClass to delegate cpu and pids."; return 1 ;;
    esac
  done

  uid=$(id -u "$user" 2>/dev/null) || {
    delegation_error "The cgroup workload user $user does not exist. Rebuild the Valet sandbox image."; return 1
  }
  gid=$(id -g "$user" 2>/dev/null) || {
    delegation_error "The cgroup workload group for $user does not exist. Rebuild the Valet sandbox image."; return 1
  }
  set -- "$path" "$path/cgroup.procs" "$path/cgroup.threads" "$path/cgroup.subtree_control"
  for target in "$@"; do
    [ -e "$target" ] || {
      delegation_error "The required cgroup file ${target#"$root"} is missing. Recreate the sandbox with the valet-docker RuntimeClass."; return 1
    }
  done
  cgroup_chown "$uid:$gid" "$@" || {
    delegation_error "Cannot delegate /sys/fs/cgroup/$leaf to $user. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
  }
  for target in "$@"; do
    [ "$(cgroup_stat "$target")" = "$uid:$gid" ] || {
      delegation_error "The ownership check failed for ${target#"$root"}. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
    }
    cgroup_user_can_write "$uid" "$gid" "$target" || {
      delegation_error "${target#"$root"} is not writable by $user. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
    }
  done
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "$#" -eq 3 ] || { echo "Usage: $0 CGROUP_ROOT LEAF USER" >&2; exit 2; }
  delegate_cgroup_leaf "$@"
fi

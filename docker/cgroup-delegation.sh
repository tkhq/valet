#!/usr/bin/env bash
# Establish the delegated cgroup v2 manager used by nested runtimes.
# Wrappers are functions so fake-tree tests can inject cgroupfs behavior.
set -u

cgroup_chown() { chown "$@"; }
cgroup_stat() { stat -Lc '%u:%g' "$1"; }
cgroup_user_can_write() {
  setpriv --reuid "$1" --regid "$2" --clear-groups test -w "$3"
}
cgroup_mkdir() { mkdir -p "$1"; }
cgroup_move_pid() { printf '%s\n' "$2" > "$1"; }
cgroup_enable() { printf '%s\n' "$2" > "$1"; }
delegation_error() { printf 'Error: %s\n' "$1" >&2; return 1; }

has_word() { case " $1 " in *" $2 "*) return 0;; *) return 1;; esac; }

establish_cgroup_topology() {
  local root=$1 user=$2 manager="$1/init" services="$1/init/services"
  local controllers enabled uid gid target pid pass
  [ -d "$manager" ] && [ ! -L "$manager" ] || delegation_error \
    "The required cgroup manager /init is missing or unsafe. Recreate the sandbox with the valet-docker RuntimeClass." || return 1
  for target in cgroup.controllers cgroup.procs cgroup.threads cgroup.subtree_control; do
    [ -e "$manager/$target" ] || {
      delegation_error "The required cgroup file /init/$target is missing. Recreate the sandbox with the valet-docker RuntimeClass."; return 1
    }
  done
  if [ -e "$services" ] && { [ ! -d "$services" ] || [ -L "$services" ]; }; then
    delegation_error "The cgroup path /init/services is unsafe. Recreate the sandbox."; return 1
  fi
  for target in "$manager"/*; do
    [ -d "$target" ] || continue
    case "$target" in "$services"|"$manager/tkhq-k3s") ;; *)
      delegation_error "The cgroup manager /init has an unexpected child. Recreate the sandbox."; return 1;;
    esac
  done
  cgroup_mkdir "$services" || {
    delegation_error "Cannot create /init/services. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
  }
  [ "$(cgroup_stat "$services")" = "0:0" ] || {
    delegation_error "The cgroup /init/services is not owned by mapped root. Recreate the sandbox."; return 1
  }

  # cgroup.procs moves all threads in a process. Use shell builtins so this
  # helper does not create a new direct member while it evacuates itself.
  for pass in {1..10}; do
    while IFS= read -r pid; do
      if [ -n "$pid" ] && ! cgroup_move_pid "$services/cgroup.procs" "$pid"; then
        delegation_error "Cannot move process $pid from /init to /init/services. Recreate the sandbox."; return 1
      fi
    done < "$manager/cgroup.procs"
    [ ! -s "$manager/cgroup.procs" ] && [ ! -s "$manager/cgroup.threads" ] && break
    [ "$pass" -lt 10 ] && sleep 0.1
  done
  if [ -s "$manager/cgroup.procs" ] || [ -s "$manager/cgroup.threads" ]; then
    delegation_error "Processes keep entering /init. Use the Valet PID 1 service topology, then recreate the sandbox."; return 1
  fi

  controllers=$(cat "$manager/cgroup.controllers") || return 1
  for target in cpu pids; do
    has_word "$controllers" "$target" || {
      delegation_error "The $target cgroup controller is unavailable. Configure the valet-docker RuntimeClass to delegate cpu and pids."; return 1
    }
  done
  enabled=${controllers// / +}; enabled="+${enabled}"
  cgroup_enable "$manager/cgroup.subtree_control" "$enabled" || {
    delegation_error "Cannot enable controllers below /init. Ensure /init is empty, then recreate the sandbox."; return 1
  }
  enabled=$(cat "$manager/cgroup.subtree_control") || return 1
  for target in cpu pids; do
    has_word "$enabled" "$target" || {
      delegation_error "The $target controller was not enabled below /init. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
    }
    has_word "$(cat "$services/cgroup.controllers")" "$target" || {
      delegation_error "The cgroup /init/services did not inherit $target. Recreate the sandbox."; return 1
    }
  done

  uid=$(id -u "$user" 2>/dev/null) || {
    delegation_error "The cgroup workload user $user does not exist. Rebuild the Valet sandbox image."; return 1
  }
  gid=$(id -g "$user" 2>/dev/null) || {
    delegation_error "The cgroup workload group for $user does not exist. Rebuild the Valet sandbox image."; return 1
  }
  set -- "$manager" "$manager/cgroup.procs" "$manager/cgroup.threads" "$manager/cgroup.subtree_control"
  for target in "$@"; do
    [ -e "$target" ] || {
      delegation_error "The required cgroup file ${target#"$root"} is missing. Recreate the sandbox with the valet-docker RuntimeClass."; return 1
    }
  done
  cgroup_chown "$uid:$gid" "$@" || {
    delegation_error "Cannot delegate /sys/fs/cgroup/init to $user. Correct the valet-docker RuntimeClass and recreate the sandbox."; return 1
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
  [ "$#" -eq 2 ] || { echo "Usage: $0 CGROUP_ROOT USER" >&2; exit 2; }
  [ "$1" = /sys/fs/cgroup ] || delegation_error \
    "Refusing the unexpected cgroup root $1. Rebuild the Valet sandbox image." || exit 1
  establish_cgroup_topology "$@"
fi

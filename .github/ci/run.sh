#!/usr/bin/env bash
set -euo pipefail

test_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node_bin=$(command -v node)
scratch=$(mktemp -d /tmp/dsh-session-bridge-ci.XXXXXXXX)
trap 'rm -r -- "$scratch"' EXIT
mkdir -m 700 "$scratch"/{home,config,data,cache,state,run,tmp}
test_command=(/usr/bin/env -i PATH=/usr/bin:/bin HOME="$scratch/home"
  XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data" XDG_CACHE_HOME="$scratch/cache"
  XDG_STATE_HOME="$scratch/state" XDG_RUNTIME_DIR="$scratch/run" TMPDIR="$scratch/tmp"
  "$node_bin" --test "$test_dir/regression.mjs")

if /usr/bin/unshare -Urn /usr/sbin/ip link set lo up 2>/dev/null; then
  /usr/bin/unshare -Urn /bin/sh -eu -c '/usr/sbin/ip link set lo up; exec "$@"' sh "${test_command[@]}"
elif [[ ${GITHUB_ACTIONS:-} == true ]]; then
  # Hosted Ubuntu can use passwordless sudo when unprivileged namespaces are restricted.
  # Only network setup runs with host privilege. Drop to the runner UID before Node.
  sudo -n /usr/bin/unshare --net /bin/sh -eu -c '
    /usr/sbin/ip link set lo up
    uid=$1 gid=$2
    shift 2
    exec /usr/bin/setpriv --reuid "$uid" --regid "$gid" --init-groups --no-new-privs "$@"
  ' sh "$(id -u)" "$(id -g)" "${test_command[@]}"
else
  printf 'Loopback-only network namespace unavailable.\n' >&2
  exit 1
fi

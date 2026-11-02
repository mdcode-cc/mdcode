#!/usr/bin/env bash
# For every profile's package.json (this repo's profiles/cc + every profile
# under $DSH_HOME/profiles/*), fail if any `dependencies` key names a package
# the host dsh install already ships.
#
# Reason: declaring a host-shipped package as a profile DIRECT DEPENDENCY
# makes dsh-app-boot's routeLocalPackage hand that package's resolution to
# plain Node instead of the host's own copy, so a second module instance
# loads and every Symbol-keyed registry (dsh-scope's kScope) splits across
# the two instances — presets then fail to mount with "prompt section ...
# is already registered". Verified with real boots. Only out-of-tree
# packages (e.g. @deepseek-ai/dsh-hooks-claude-code,
# @deepseek-harness-tui/dsh-tui, @markishh/*) belong in a profile's
# package.json `dependencies`.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"

# Locate the host dsh install tree's package root (holds node_modules/@deepseek-ai/*).
# 1. npm's global root, if dsh is installed there.
# 2. walk up from the resolved `dsh` binary — @deepseek-ai/dsh ships its bin
#    at <pkg-root>/lib/bin.js, so two dirnames reach <pkg-root>.
# 3. last-resort fallback: the one known-good path on this host.
resolve_host_dsh() {
  local npm_root bin resolved pkg_root
  if npm_root="$(npm root -g 2>/dev/null)" && [ -d "$npm_root/@deepseek-ai/dsh" ]; then
    echo "$npm_root/@deepseek-ai/dsh"
    return 0
  fi
  if bin="$(command -v dsh 2>/dev/null)"; then
    resolved="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
    pkg_root="$(dirname "$(dirname "$resolved")")"
    if [ -d "$pkg_root/node_modules/@deepseek-ai" ]; then
      echo "$pkg_root"
      return 0
    fi
  fi
  echo "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh"
}
HOST_DSH="${HOST_DSH:-$(resolve_host_dsh)}"

if [ ! -d "$HOST_DSH" ]; then
  echo "FAIL: host dsh install tree not found at $HOST_DSH"
  exit 1
fi

HOST_PKGS="$(mktemp)"
trap 'rm -f "$HOST_PKGS"' EXIT
echo "@deepseek-ai/dsh" > "$HOST_PKGS"
for d in "$HOST_DSH"/node_modules/@deepseek-ai/*/; do
  [ -d "$d" ] || continue
  echo "@deepseek-ai/$(basename "$d")" >> "$HOST_PKGS"
done

rc=0

check_profile() {
  local pkg="$1" profile="$2"
  [ -f "$pkg" ] || return 0
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if grep -qxF "$name" "$HOST_PKGS"; then
      printf 'FAIL  %-14s %-42s host-shipped package declared as a profile direct dependency -> second module instance splits dsh-scope kScope, presets fail "already registered"\n' "$profile" "$name"
      rc=1
    fi
  done < <(node -e '
    const fs = require("node:fs")
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    for (const name of Object.keys(p.dependencies || {})) console.log(name)
  ' "$pkg")
}

check_profile "$ROOT/profiles/cc/package.json" "repo:cc"

shopt -s nullglob
for pkg in "$DSH_HOME"/profiles/*/package.json; do
  profile="$(basename "$(dirname "$pkg")")"
  check_profile "$pkg" "$profile"
done

[ "$rc" -eq 0 ] && echo "profile deps: no host-shipped packages declared direct" \
                 || echo "profile deps: violations found"
exit "$rc"

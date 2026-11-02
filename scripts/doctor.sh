#!/usr/bin/env bash
# Compare the installed dsh host version against every @deepseek-ai/* pin in the
# profiles' package.json files. Exits 1 on any mismatch.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "no host found: dsh not on PATH, skipping doctor checks (e.g. in CI)"
  exit 0
fi

HOST="$(dsh --version 2>/dev/null | tr -d '[:space:]')"
if [ -z "$HOST" ]; then
  echo "FAIL: dsh --version produced no output"
  exit 1
fi
echo "host dsh: $HOST"

rc=0
shopt -s nullglob
for pkg in "$ROOT"/profiles/*/package.json; do
  profile="$(basename "$(dirname "$pkg")")"
  # Emit "<name>\t<range>" for every @deepseek-ai/* dependency.
  while IFS=$'\t' read -r name range; do
    [ -z "$name" ] && continue
    if [ "$range" = "$HOST" ]; then
      printf '  ok    %-14s %-42s %s\n' "$profile" "$name" "$range"
    else
      printf '  DRIFT %-14s %-42s %s (host %s)\n' "$profile" "$name" "$range" "$HOST"
      rc=1
    fi
  done < <(node -e '
    const fs = require("node:fs")
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const deps = { ...p.dependencies, ...p.devDependencies, ...p.peerDependencies }
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith("@deepseek-ai/")) console.log(`${name}\t${range}`)
    }
  ' "$pkg")
done

# Plugin peer ranges are checked against the host version too, except for
# cordis and schemastery: those are versioned independently of the harness.
echo "plugin peer ranges:"
for pkg in "$ROOT"/packages/*/package.json; do
  node -e '
    const fs = require("node:fs")
    const SKIP = new Set(["@deepseek-ai/cordis", "@deepseek-ai/schemastery"])
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    for (const [name, range] of Object.entries(p.peerDependencies ?? {})) {
      if (!name.startsWith("@deepseek-ai/") || SKIP.has(name)) continue
      const ok = range.split("||").map(s => s.trim()).includes(process.argv[2])
      console.log(`  ${ok ? "ok   " : "DRIFT"} ${p.name} ${name} ${range}`)
      if (!ok) process.exitCode = 1
    }
  ' "$pkg" "$HOST" || rc=1
done

[ "$rc" -eq 0 ] && echo "profiles: all pins match the host" || echo "profiles: drift found"

# Leaked-credential scan: a cordis.patch.yml (or anything else in the repo)
# should only ever carry `!!js process.env.<NAME>` references, never a
# literal key value copied out of ~/.claude.json by gen-mcp-rows.mjs. Same
# prefix set gen-mcp-rows.mjs itself refuses to emit.
echo "secret scan:"
SECRET_HITS="$(grep -rnE '(^|[^A-Za-z0-9_-])(AQ\.|AIza|sk-|phc_|phx_|ghp_|xox)[A-Za-z0-9_-]{8,}' \
  --exclude-dir=node_modules --exclude-dir=.git "$ROOT" 2>/dev/null)"
if [ -n "$SECRET_HITS" ]; then
  echo "FAIL: literal credential-shaped values found in the repo:"
  echo "$SECRET_HITS" | sed -E 's/(AQ\.|AIza|sk-|phc_|phx_|ghp_|xox)[A-Za-z0-9_-]{8,}/[redacted]/g'
  rc=1
else
  echo "  ok    no credential-shaped literals found"
fi

echo "profile direct deps vs host install tree:"
"$ROOT/scripts/doctor-profile-deps.sh" || rc=1

exit "$rc"

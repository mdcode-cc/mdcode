#!/usr/bin/env bash
# Materialize the `cc` profile under a dsh DSH_HOME from this checkout's
# profiles/cc/, with the six @mdcode-cc `link:` deps rewritten to absolute
# paths into this checkout (a profile resolves `link:` relative to its own
# package.json, not the repo root, so a relative path breaks once the
# profile and the checkout aren't siblings). Idempotent — re-run any time
# this checkout moves, updates, or DSH_HOME changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${1:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/cc"

mkdir -p "$PROFILE_DIR"

node -e '
const fs = require("node:fs");
const path = require("node:path");
const [root, dir] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "profiles/cc/package.json"), "utf8"));
for (const [name, range] of Object.entries(pkg.dependencies)) {
  if (range.startsWith("link:")) {
    pkg.dependencies[name] = "link:" + path.resolve(root, "profiles/cc", range.slice(5));
  }
}
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
' "$ROOT" "$PROFILE_DIR"

cp "$ROOT/profiles/cc/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"

TUI_RANGE="$(node -e "console.log(require('$ROOT/profiles/cc/package.json').dependencies['@deepseek-harness-tui/dsh-tui'])")"

# allowBuilds is a pnpm-workspace.yaml key, not a CLI flag: it pre-approves
# the native deps' postinstall scripts so `pnpm install` below never stops
# for the interactive build-script prompt pnpm 10+ requires by default.
# minimumReleaseAgeExclude avoids ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION on a
# dsh-tui release still inside pnpm's default minimum-release-age window.
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<EOF
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  koffi: true
  node-pty: true
  protobufjs: true
minimumReleaseAgeExclude:
  - '@deepseek-harness-tui/dsh-tui@$TUI_RANGE'
EOF

(cd "$PROFILE_DIR" && pnpm install)

cat <<EOF

cc profile ready at $PROFILE_DIR

Launch:
  DSH_HOME=$DSH_HOME dsh --profile cc
  DSH_HOME=$DSH_HOME dsh --profile headless "reply with the single word OK"
EOF

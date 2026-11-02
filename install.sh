#!/usr/bin/env bash
# mdcode installer: sets up a dsh `cc` profile with the six @mdcode-cc
# plugins from published npm packages.
#   curl -fsSL https://raw.githubusercontent.com/mdcode-cc/mdcode/main/install.sh | bash
# or locally: bash install.sh
set -euo pipefail
MDCODE_VERSION="${MDCODE_VERSION:-0.1.1}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MDCODE_REF="${MDCODE_REF:-main}"
MDCODE_RAW_BASE="${MDCODE_RAW_BASE:-https://raw.githubusercontent.com/mdcode-cc/mdcode/$MDCODE_REF}"
DSH_VERSION="${DSH_VERSION:-}"
DRY_RUN=false
for arg in "$@"; do [ "$arg" = "--dry-run" ] && DRY_RUN=true; done
fail() { echo "FAILED at step: $1" >&2; exit 1; }
step() { echo; echo "==> $1"; }
step "1/7 checking node and npm"
command -v node >/dev/null 2>&1 || fail "node not found (need Node >= 22)"
command -v npm >/dev/null 2>&1 || fail "npm not found"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node $(node -v) found, need >= 22"
echo "node $(node -v), npm $(npm -v)"
step "2/7 ensuring pnpm"
if command -v pnpm >/dev/null 2>&1; then
  echo "pnpm already present: $(pnpm --version)"
elif $DRY_RUN; then
  echo "[dry-run] would run: corepack enable && corepack prepare pnpm@latest --activate (fallback: npm install -g pnpm)"
elif command -v corepack >/dev/null 2>&1 && corepack enable >/dev/null 2>&1 \
    && corepack prepare pnpm@latest --activate >/dev/null 2>&1; then
  echo "pnpm installed via corepack: $(pnpm --version)"
else
  npm install -g pnpm || fail "install pnpm"
  echo "pnpm installed via npm: $(pnpm --version)"
fi
step "3/7 resolving dsh host version"
if [ -z "$DSH_VERSION" ]; then
  DSH_VERSION="$(curl -fsSL "$MDCODE_RAW_BASE/scripts/host.version" 2>/dev/null | tr -d '[:space:]')"
  [ -n "$DSH_VERSION" ] || DSH_VERSION="0.2.1-rc.5"
fi
echo "target dsh version: $DSH_VERSION"
CURRENT_DSH="$(dsh --version 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$CURRENT_DSH" = "$DSH_VERSION" ]; then
  echo "dsh $CURRENT_DSH already installed"
elif $DRY_RUN; then
  echo "[dry-run] would run: npm install -g @deepseek-ai/dsh@$DSH_VERSION"
else
  npm install -g "@deepseek-ai/dsh@$DSH_VERSION" || fail "install dsh host"
  echo "installed dsh $(dsh --version 2>/dev/null)"
fi
step "4/7 setting up \$DSH_HOME/profiles/cc"
PROFILE_DIR="$DSH_HOME/profiles/cc"
if $DRY_RUN; then
  echo "[dry-run] would mkdir -p $PROFILE_DIR, fetch cordis.patch.yml + package.json template,"
  echo "[dry-run] write package.json (six @mdcode-cc/* @ $MDCODE_VERSION, backing up any existing one),"
  echo "[dry-run] write pnpm-workspace.yaml, and run pnpm install in $PROFILE_DIR"
else
  mkdir -p "$PROFILE_DIR"
  curl -fsSL "$MDCODE_RAW_BASE/profiles/cc/cordis.patch.yml" -o "$PROFILE_DIR/cordis.patch.yml" \
    || fail "fetch cordis.patch.yml"
  TMP_PKG="$(mktemp)"
  curl -fsSL "$MDCODE_RAW_BASE/profiles/cc/package.json" -o "$TMP_PKG" || fail "fetch package.json template"
  # one node call, one read: versions come from the fetched template, never hardcoded here
  NODE_OUT="$(node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const d = p.dependencies;
console.log([d["@deepseek-ai/dsh-hook-protocol"], d["@deepseek-ai/dsh-hooks-claude-code"],
  d["@deepseek-harness-tui/dsh-tui"], JSON.stringify(p.dsh.profile.bundles)].join("\t"));
' "$TMP_PKG")"
  IFS=$'\t' read -r HOOK_PROTOCOL_VERSION HOOKS_CC_VERSION TUI_VERSION BUNDLES_JSON <<< "$NODE_OUT"
  if [ -f "$PROFILE_DIR/package.json" ]; then
    BACKUP="$PROFILE_DIR/package.json.bak-$(date +%Y%m%d%H%M%S)"
    cp "$PROFILE_DIR/package.json" "$BACKUP"
    echo "backed up existing package.json -> $BACKUP"
  fi
  node -e '
const fs = require("fs");
const [outPath, mdcodeVersion, hookProtocolVersion, hooksCCVersion, tuiVersion, bundlesJson] = process.argv.slice(1);
const names = ["dsh-agents-md","dsh-task-tool","dsh-model-tiers","dsh-commands-md","dsh-plugin-log","dsh-hooks-approval"];
const deps = {
  "@deepseek-ai/dsh-hook-protocol": hookProtocolVersion,
  "@deepseek-ai/dsh-hooks-claude-code": hooksCCVersion,
  "@deepseek-harness-tui/dsh-tui": tuiVersion,
};
for (const n of names) deps["@mdcode-cc/" + n] = mdcodeVersion;
const pkg = { name: "dsh-profile-cc", version: "0.0.0", private: true,
  description: "The cc profile: dsh-base + the TUI front-end + the six mdcode plugins.",
  dependencies: deps, dsh: { profile: { bundles: JSON.parse(bundlesJson) } } };
fs.writeFileSync(outPath, JSON.stringify(pkg, null, 2) + "\n");
' "$PROFILE_DIR/package.json" "$MDCODE_VERSION" "$HOOK_PROTOCOL_VERSION" "$HOOKS_CC_VERSION" "$TUI_VERSION" "$BUNDLES_JSON" \
    || fail "write profile package.json"
  rm -f "$TMP_PKG"
  cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<YAML
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': true
  koffi: true
  node-pty: true
  protobufjs: true
minimumReleaseAgeExclude:
  - '@deepseek-harness-tui/dsh-tui@$TUI_VERSION'
YAML
  (cd "$PROFILE_DIR" && pnpm install) || fail "pnpm install in profile"
fi
step "5/7 DeepSeek API key"
if [ -n "${DEEPSEEK_API_KEY:-}" ] || grep -q '^DEEPSEEK_API_KEY=' "$DSH_HOME/.env" 2>/dev/null; then
  echo "DEEPSEEK_API_KEY already set or stored, skipping prompt"
elif $DRY_RUN; then
  echo "[dry-run] would prompt for DEEPSEEK_API_KEY on /dev/tty and append to $DSH_HOME/.env (chmod 600)"
else
  printf 'Enter DEEPSEEK_API_KEY (input hidden): ' > /dev/tty
  IFS= read -rs DEEPSEEK_KEY_INPUT < /dev/tty
  printf '\n' > /dev/tty
  if [ -z "$DEEPSEEK_KEY_INPUT" ]; then
    echo "no key entered, skipping. Add it later with:"
    echo "  echo DEEPSEEK_API_KEY=sk-... >> $DSH_HOME/.env   (or export it before launching)"
  else
    mkdir -p "$DSH_HOME"
    touch "$DSH_HOME/.env"
    chmod 600 "$DSH_HOME/.env"
    printf 'DEEPSEEK_API_KEY=%s\n' "$DEEPSEEK_KEY_INPUT" >> "$DSH_HOME/.env"
    echo "wrote DEEPSEEK_API_KEY to $DSH_HOME/.env"
  fi
fi
step "6/7 global rules file"
if [ -f "$HOME/.claude/CLAUDE.md" ] && [ ! -e "$DSH_HOME/AGENTS.md" ]; then
  if $DRY_RUN; then
    echo "[dry-run] would symlink $DSH_HOME/AGENTS.md -> $HOME/.claude/CLAUDE.md"
  else
    ln -s "$HOME/.claude/CLAUDE.md" "$DSH_HOME/AGENTS.md"
    echo "symlinked $DSH_HOME/AGENTS.md -> $HOME/.claude/CLAUDE.md"
  fi
else
  echo "nothing to do ($HOME/.claude/CLAUDE.md missing, or $DSH_HOME/AGENTS.md already exists)"
fi
step "7/7 verifying profile"
if $DRY_RUN; then
  echo "[dry-run] would run: DSH_HOME=$DSH_HOME dsh --profile cc --dump-config"
else
  DSH_HOME="$DSH_HOME" dsh --profile cc --dump-config >/dev/null || fail "dsh --profile cc --dump-config"
  echo "profile cc composes cleanly"
fi
echo
echo "Launch:"
if [ "$DSH_HOME" = "$HOME/.dsh" ]; then
  echo "  dsh --profile cc"
else
  echo "  DSH_HOME=$DSH_HOME dsh --profile cc"
fi

#!/usr/bin/env node
// Reads ~/.claude.json `mcpServers` and emits dsh-mcp-client cordis.patch.yml
// rows (YAML) to stdout, in the shape ~/.dsh/cordis.patch.yml already uses.
//
// Skips: servers already mounted at dsh home level — read dynamically from
// $DSH_HOME/cordis.patch.yml's own `serverName:` values below, so this
// script carries no hardcoded list of personal service names — and
// known-broken servers (grid/tabularis: grid's localhost bridge isn't
// running, tabularis.app isn't installed at the path its stdio command
// names). Pass `--skip name,name` to drop additional servers by name (e.g.
// a deprecated or noisy one not worth mounting at all) without editing this
// file.
//
// STDERR REDIRECT: every stdio row's `command`/`args` run the real command
// through `/bin/sh -c 'mkdir -p ... && exec <real command> ... 2>>"<log>"'`
// instead of invoking it directly, so a chatty child's stderr (deprecation
// banners, usage-statistics notices, "connected" lines) lands in
// `$DSH_HOME/logs/mcp-<serverName>.log` instead of printing over the host
// TUI — dsh-mcp-client inherits the child's stderr fd as-is and exposes no
// config knob for it (see profiles/cc/cordis.patch.yml section 5 for the
// full mechanism note). `exec` keeps the real command's pid as the direct
// child so shutdown still signals it, not an extra `sh` layer. `DSH_HOME` is
// re-added via the row's own `env` because dsh-mcp-client's child-env scrub
// drops ambient `DSH_*` names before configured `env` merges on top.
//
// SECURITY: this script never emits a literal `env` or `headers` value — only
// `!!js process.env.<NAME>` references (see profiles/cc/cordis.patch.yml for
// what evaluates that tag). ~/.claude.json holds real credentials in those
// fields; emitting them into a file meant for a public repo was a real
// leaked-credential bug this script now refuses to repeat. The env var names
// a generated profile needs are printed to stderr, never stdout.
//
// Usage: node scripts/gen-mcp-rows.mjs [--skip name,name] > /tmp/mcp-rows.yml

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KNOWN_BROKEN = new Set(['grid', 'tabularis']);

// `--skip name,name` — additional server names to drop, e.g. deprecated or
// out-of-scope servers the caller doesn't want mounted at all.
function cliSkipNames(argv) {
  const flag = argv.find((a) => a === '--skip' || a.startsWith('--skip='));
  if (!flag) return new Set();
  const value = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : argv[argv.indexOf(flag) + 1];
  if (!value) return new Set();
  return new Set(value.split(',').map((s) => s.trim()).filter(Boolean));
}

// Server names already mounted at the home-level patch, so this script
// never duplicates a row dsh would then fail to compose ("already
// registered") — read, not hardcoded, so no personal service name lives in
// this file.
function homeLevelServerNames() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const names = new Set();
  try {
    const text = readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8');
    for (const m of text.matchAll(/serverName:\s*['"]?([^\s'"]+)/g)) names.add(m[1]);
  } catch {
    // no home-level patch, or unreadable — nothing to skip on that basis
  }
  return names;
}

const SKIP = new Set([...homeLevelServerNames(), ...KNOWN_BROKEN, ...cliSkipNames(process.argv.slice(2))]);

// Header -> env var name overrides, keyed by `<serverName>:<header lowercased>`.
// Add an entry here when the generic derivation below would pick a worse name.
const HEADER_ENV_OVERRIDES = {
  'stitch:x-goog-api-key': 'STITCH_API_KEY',
};

const SECRET_VALUE_PATTERN = /^(AQ\.|AIza|sk-|phc_|phx_|ghp_|xox)/;

const claudeJsonPath = join(homedir(), '.claude.json');
const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
const servers = claudeJson.mcpServers || {};

// Minimal YAML scalar quoting: wrap in single quotes if it contains chars
// that would otherwise change meaning; double single-quotes inside.
function yq(v) {
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (/^[A-Za-z0-9_\-./:]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

// `NAME: !!js process.env.NAME` — the entry-list YAML dialect's expression
// scalar, evaluated against the real process environment at mount time.
function jsEnvRef(envName) {
  return `!!js process.env.${envName}`;
}

// Derive the env var a header's value should come from: a known override,
// else `<SERVERNAME_UPPER>_<HEADER_UPPER_SNAKE>`.
function headerEnvName(serverName, header) {
  const override = HEADER_ENV_OVERRIDES[`${serverName}:${header.toLowerCase()}`];
  if (override) return override;
  const upperSnake = (s) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${upperSnake(serverName)}_${upperSnake(header)}`;
}

function emitList(arr, indent) {
  const pad = ' '.repeat(indent);
  return arr.map((v) => `${pad}- ${yq(v)}`).join('\n');
}

// POSIX single-quote shell-quoting for one argument: safe for any byte,
// embeds a literal single quote as '"'"'.
function shQuote(v) {
  return `'${String(v).replace(/'/g, `'"'"'`)}'`;
}

// `/bin/sh -c '...'` body that runs `command args...` with stderr redirected
// to this server's own log file instead of inherited by the host TUI, and
// `exec`s into it so the real command's pid — not an extra `sh` layer — is
// the direct child dsh-mcp-client supervises and signals on shutdown.
function buildStdioExecScript(serverName, command, args) {
  const real = [command, ...(args || [])].map(shQuote).join(' ');
  const logDir = '$MDCODE_LOG_DIR';
  const logFile = `${logDir}/mcp-${serverName}.log`;
  return `mkdir -p "${logDir}" && exec ${real} 2>>"${logFile}"`;
}

// Every `env`/`headers` entry becomes a `!!js process.env.<NAME>` reference —
// the literal value from ~/.claude.json is read only to know the key exists,
// never written out. `requiredEnvVars` collects the names so the caller can
// report what to set, without ever seeing the values.
function emitEnvRefs(obj, indent, requiredEnvVars) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const name of Object.keys(obj)) {
    requiredEnvVars.add(name);
    lines.push(`${pad}${name}: ${jsEnvRef(name)}`);
  }
  return lines.join('\n');
}

function emitHeaderRefs(serverName, obj, indent, requiredEnvVars) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const header of Object.keys(obj)) {
    const envName = headerEnvName(serverName, header);
    requiredEnvVars.add(envName);
    lines.push(`${pad}${header}: ${jsEnvRef(envName)}`);
  }
  return lines.join('\n');
}

const rows = [];
const requiredEnvVars = new Set();

for (const [name, server] of Object.entries(servers)) {
  if (SKIP.has(name)) continue;

  const isHttp = server.type === 'http' || !!server.url;
  const lines = [];
  lines.push(`- id: mcp-${name}`);
  lines.push(`  name: '@deepseek-ai/dsh-mcp-client'`);
  lines.push(`  config:`);
  lines.push(`    serverName: ${yq(name)}`);

  if (isHttp) {
    lines.push(`    transport: streamable-http`);
    lines.push(`    url: ${yq(server.url)}`);
    if (server.headers && Object.keys(server.headers).length) {
      lines.push(`    headers:`);
      lines.push(emitHeaderRefs(name, server.headers, 6, requiredEnvVars));
    }
  } else {
    lines.push(`    transport: stdio`);
    lines.push(`    command: /bin/sh`);
    lines.push(`    args:`);
    lines.push(emitList(['-c', buildStdioExecScript(name, server.command, server.args)], 6));
    // MDCODE_LOG_DIR is computed at config time so it is always a string even when DSH_HOME is unset; dsh-mcp-client's child-env scrub drops
    // ambient DSH_* names before configured `env` merges on top, so the
    // `${DSH_HOME:-...}` fallback in the script above needs this re-added
    // explicitly or it silently uses the wrong log directory.
    lines.push(`    env:`);
    lines.push(`      DSH_HOME: ${jsEnvRef('DSH_HOME')}`);
    if (server.env && Object.keys(server.env).length) {
      lines.push(emitEnvRefs(server.env, 6, requiredEnvVars));
    }
    if (server.cwd) lines.push(`    cwd: ${yq(server.cwd)}`);
  }

  lines.push(`    toolCallTimeoutMs: 60000`);
  lines.push(`    failOnStartupError: false`);
  rows.push(lines.join('\n'));
}

const output = rows.join('\n') + '\n';

// Redacted-value sanity check: refuse to emit anything that still looks like
// a live credential. This should never fire given the code above, but it is
// the last line of defense against a future edit that reintroduces a literal.
for (const line of output.split('\n')) {
  const m = line.match(/:\s*'?([^\s']+)/);
  if (m && SECRET_VALUE_PATTERN.test(m[1])) {
    process.stderr.write(`gen-mcp-rows: refusing to emit a line that looks like a literal credential: ${line.replace(/:\s*.*/, ': [redacted]')}\n`);
    process.exit(1);
  }
}

if (requiredEnvVars.size) {
  process.stderr.write('gen-mcp-rows: set these env vars before mounting (see cordis.patch.yml comments):\n');
  for (const name of [...requiredEnvVars].sort()) {
    process.stderr.write(`  ${name}\n`);
  }
}

process.stdout.write(output);

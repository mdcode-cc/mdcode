#!/usr/bin/env node
// Bump every @deepseek-ai/* pin that equals the current pinned host version
// (scripts/host.version) to a new version, across packages/*/package.json
// and profiles/cc/package.json.
//
// Usage:
//   node scripts/bump-host.mjs --to <version>
//   node scripts/bump-host.mjs --latest
//   node scripts/bump-host.mjs --check   (exit 1 if a newer host exists)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HOST_VERSION_FILE = join(ROOT, "scripts/host.version");
const HOST_PACKAGE = "@deepseek-ai/dsh";

export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)\.(\d+))?$/.exec(v);
  if (!m) throw new Error(`cannot parse version: ${v}`);
  const [, major, minor, patch, tag, num] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    pre: tag ? { tag, num: Number(num) } : null,
  };
}

// Prerelease-aware compare: returns -1/0/1. 0.2.1-rc.5 < 0.2.1-rc.6 <
// 0.2.2-alpha.1 < 0.2.2 (no prerelease sorts above any prerelease of the
// same major.minor.patch, per semver).
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (const k of ["major", "minor", "patch"]) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  if (pa.pre.tag !== pb.pre.tag) return pa.pre.tag < pb.pre.tag ? -1 : 1;
  if (pa.pre.num !== pb.pre.num) return pa.pre.num < pb.pre.num ? -1 : 1;
  return 0;
}

function fetchLatest() {
  return execSync(`npm view ${HOST_PACKAGE} dist-tags.latest`, { encoding: "utf8" }).trim();
}

function targetPackageFiles() {
  const files = [];
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgFile = join(ROOT, "packages", entry.name, "package.json");
    if (existsSync(pkgFile)) files.push(pkgFile);
  }
  const profileCc = join(ROOT, "profiles/cc/package.json");
  if (existsSync(profileCc)) files.push(profileCc);
  return files;
}

function bump(oldVersion, newVersion) {
  const changed = [];
  for (const file of targetPackageFiles()) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    let touched = false;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const section = pkg[field];
      if (!section) continue;
      for (const name of Object.keys(section)) {
        if (name.startsWith("@deepseek-ai/") && section[name] === oldVersion) {
          section[name] = newVersion;
          touched = true;
        }
      }
    }
    if (touched) {
      writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
      changed.push(relative(ROOT, file));
    }
  }
  writeFileSync(HOST_VERSION_FILE, newVersion + "\n");
  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const oldVersion = readFileSync(HOST_VERSION_FILE, "utf8").trim();

  if (args.includes("--check")) {
    const latest = fetchLatest();
    console.log(`pinned: ${oldVersion}`);
    console.log(`latest: ${latest}`);
    if (compareVersions(latest, oldVersion) > 0) {
      console.log(`newer host available: ${latest}`);
      process.exit(1);
    }
    console.log("up to date");
    return;
  }

  let newVersion;
  if (args.includes("--latest")) {
    newVersion = fetchLatest();
  } else {
    const toIdx = args.indexOf("--to");
    if (toIdx === -1 || !args[toIdx + 1]) {
      console.error("usage: bump-host.mjs --to <version> | --latest | --check");
      process.exit(1);
    }
    newVersion = args[toIdx + 1];
  }

  if (newVersion === oldVersion) {
    console.log(`host.version already at ${oldVersion}; nothing to do`);
    return;
  }

  const changed = bump(oldVersion, newVersion);
  console.log(`host: ${oldVersion} -> ${newVersion}`);
  if (changed.length === 0) {
    console.log("no files changed");
  } else {
    console.log("changed files:");
    for (const f of changed) console.log(`  ${f}`);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

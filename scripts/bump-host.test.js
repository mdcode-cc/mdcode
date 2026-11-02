import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions } from "./bump-host.mjs";

test("prerelease-aware ordering: rc.5 < rc.6 < alpha.1 < release", () => {
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.1-rc.6"), -1);
  assert.equal(compareVersions("0.2.1-rc.6", "0.2.2-alpha.1"), -1);
  assert.equal(compareVersions("0.2.2-alpha.1", "0.2.2"), -1);
});

test("reverse comparisons flip sign", () => {
  assert.equal(compareVersions("0.2.1-rc.6", "0.2.1-rc.5"), 1);
  assert.equal(compareVersions("0.2.2-alpha.1", "0.2.1-rc.6"), 1);
  assert.equal(compareVersions("0.2.2", "0.2.2-alpha.1"), 1);
});

test("equal versions compare equal", () => {
  assert.equal(compareVersions("0.2.1-rc.5", "0.2.1-rc.5"), 0);
  assert.equal(compareVersions("0.2.2", "0.2.2"), 0);
});

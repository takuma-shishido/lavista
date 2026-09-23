import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS, Workspace } from "../src/workspace.js";

function workspace(t: { after: (fn: () => void) => void }): Workspace {
  const project = mkdtempSync(join(tmpdir(), "lavista-workspace-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  return new Workspace(project);
}

test("config layers merge, and limits fall back to defaults", (t) => {
  const ws = workspace(t);
  assert.deepEqual(ws.loadConfig(), {});
  const { claude_model: _claude, astra_model: _astra, ...limits } = DEFAULT_SETTINGS;
  assert.deepEqual(ws.loadLimits(), limits);
  const [shared, local] = ws.configFiles as [string, string];
  mkdirSync(ws.directory);
  writeFileSync(shared, JSON.stringify({ max_iterations: 3, astra_model: "shared" }));
  writeFileSync(local, JSON.stringify({ max_iterations: 8 }));
  assert.deepEqual(ws.loadConfig(), { max_iterations: 8, astra_model: "shared" });
  assert.deepEqual(ws.loadLimits(), { ...limits, max_iterations: 8 });
});

test("config typos and invalid values are rejected with the file name", (t) => {
  const ws = workspace(t);
  const [shared] = ws.configFiles as [string];
  mkdirSync(ws.directory);
  writeFileSync(shared, JSON.stringify({ max_iteration: 3 }));
  assert.throws(() => ws.loadConfig(), /config\.json[\s\S]*max_iteration/);
  writeFileSync(shared, JSON.stringify({ timeout: 0 }));
  assert.throws(() => ws.loadLimits(), /timeout/);
});

test("runs are created under .lavista/runs and the latest one is found by default", (t) => {
  const ws = workspace(t);
  assert.throws(() => ws.findRun(), /No runs/);
  const first = ws.newRun(new Date("2026-01-01T00:00:00Z"));
  const second = ws.newRun(new Date("2026-01-02T00:00:00Z"));
  mkdirSync(first.directory);
  mkdirSync(second.directory);
  assert.equal(second.id, "2026-01-02T00-00-00Z");
  assert.equal(ws.findRun().directory, second.directory);
  assert.equal(ws.findRun(first.id).directory, first.directory);
  assert.equal(readFileSync(join(ws.directory, ".gitignore"), "utf8"), "runs/\nconfig.local.json\n");
});

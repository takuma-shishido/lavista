import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProcess } from "../src/process.js";

test("process adapter passes literal input and saves stdout/stderr", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lavista-process-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stdoutPath = join(cwd, "child.jsonl");
  const stderrPath = join(cwd, "child.stderr");
  const input = '日本語\n$(echo not-a-shell) `literal`';
  await runProcess({ command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout); process.stderr.write('diagnostic');"],
    input, cwd, stdoutPath, stderrPath, timeoutSeconds: 5, signal: new AbortController().signal });
  assert.equal(readFileSync(stdoutPath, "utf8"), input);
  assert.equal(readFileSync(stderrPath, "utf8"), "diagnostic");
});

test("cancellation stops a running CLI and returns control", { timeout: 10000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lavista-process-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);
  t.after(() => clearTimeout(timer));
  await assert.rejects(runProcess({ command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"], input: "", cwd,
    stdoutPath: join(cwd, "child.jsonl"), stderrPath: join(cwd, "child.stderr"), timeoutSeconds: 30, signal: controller.signal }), /Interrupted/);
});

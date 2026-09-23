import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { forceKillAll, runProcess } from "../src/process.js";

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

test("stdout lines are streamed to onLine while being saved unchanged", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lavista-process-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stdoutPath = join(cwd, "child.jsonl");
  const lines: string[] = [];
  await runProcess({ command: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"], input: '{"a":1}\n{"b":2}',
    cwd, stdoutPath, stderrPath: join(cwd, "child.stderr"), timeoutSeconds: 5,
    signal: new AbortController().signal, onLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['{"a":1}\n', '{"b":2}']);
  assert.equal(readFileSync(stdoutPath, "utf8"), '{"a":1}\n{"b":2}');
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

test("a CLI's exit completes the run even if a daemonized descendant keeps its output open", { timeout: 10000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lavista-process-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const stdoutPath = join(cwd, "child.jsonl");
  // The grandchild gets its own session (detached) and inherits stdout, like a backgrounded dev server.
  const script = `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"],
    { detached: true, stdio: "inherit" }); c.unref(); console.log(JSON.stringify({ grandchild: c.pid }));`;
  const started = Date.now();
  await runProcess({ command: process.execPath, args: ["-e", script], input: "", cwd, stdoutPath,
    stderrPath: join(cwd, "child.stderr"), timeoutSeconds: 30, signal: new AbortController().signal });
  const { grandchild } = JSON.parse(readFileSync(stdoutPath, "utf8")) as { grandchild: number };
  process.kill(grandchild, "SIGKILL");
  assert.ok(Date.now() - started < 5000, "runProcess waited for the grandchild");
});

test("a second stop request kills a CLI that ignores SIGTERM without the grace period", { timeout: 10000 }, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "lavista-process-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  const running = runProcess({ command: process.execPath,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], input: "", cwd,
    stdoutPath: join(cwd, "child.jsonl"), stderrPath: join(cwd, "child.stderr"), timeoutSeconds: 30, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const started = Date.now();
  controller.abort();
  setTimeout(forceKillAll, 200);
  await assert.rejects(running, /Interrupted/);
  assert.ok(Date.now() - started < 3000, "force kill did not skip the 5s grace period");
});

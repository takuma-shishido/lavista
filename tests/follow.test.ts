import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LineFollower } from "../src/follow.js";

test("follower reports appended lines, including split UTF-8 and a final unterminated line", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "lavista-follow-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "out.jsonl");
  writeFileSync(path, "");
  const lines: string[] = [];
  const follower = await LineFollower.open(path, (line) => lines.push(line));
  const bytes = Buffer.from("日本語\n");
  appendFileSync(path, "first\n");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(lines, ["first\n"]);
  appendFileSync(path, bytes.subarray(0, 4));
  await new Promise((resolve) => setTimeout(resolve, 250));
  appendFileSync(path, Buffer.concat([bytes.subarray(4), Buffer.from("tail")]));
  await follower.close();
  assert.deepEqual(lines, ["first\n", "日本語\n", "tail"]);
});

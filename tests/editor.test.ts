import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editorCommand, editText, SCISSORS } from "../src/editor.js";
import type { RunState } from "../src/model.js";
import { RunStore } from "../src/store.js";

function temporary(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "lavista-editor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** An "editor" that runs `body` with the file's path as `path`, and records what it was shown. */
function fakeEditor(directory: string, body: string): { editor: string; shown: () => string } {
  const script = join(directory, "editor.cjs");
  const shownPath = join(directory, "shown.txt");
  writeFileSync(script, `const fs = require("node:fs"); const path = process.argv[2];
fs.writeFileSync(${JSON.stringify(shownPath)}, fs.readFileSync(path, "utf8"));
${body}`);
  return { editor: `"${process.execPath}" "${script}"`, shown: () => readFileSync(shownPath, "utf8") };
}

test("the editor is $VISUAL, then $EDITOR, then vi", () => {
  assert.equal(editorCommand({ VISUAL: "code --wait", EDITOR: "nano" }), "code --wait");
  assert.equal(editorCommand({ EDITOR: "nano" }), "nano");
  assert.equal(editorCommand({}), "vi");
});

test("text written above the scissors line is returned, and the help below it is not", async (t) => {
  const { editor, shown } = fakeEditor(temporary(t), `fs.writeFileSync(path, "Fix the typo\\n\\n# Heading kept\\n" + fs.readFileSync(path, "utf8"));`);
  assert.equal(await editText("", "Write the goal.\nSecond line.", editor), "Fix the typo\n\n# Heading kept");
  assert.equal(shown(), `\n\n${SCISSORS}\n# Write the goal.\n# Second line.\n`);
});

test("the editor starts from the given text, and saving nothing new keeps it", async (t) => {
  const { editor, shown } = fakeEditor(temporary(t), "");
  assert.equal(await editText("From a file\n", "help", editor), "From a file");
  assert.match(shown(), /^From a file\n\n/);
});

test("an untouched empty template is empty, and a failing editor is an error", async (t) => {
  const directory = temporary(t);
  assert.equal(await editText("", "help", fakeEditor(directory, "").editor), "");
  await assert.rejects(editText("", "help", fakeEditor(directory, "process.exit(1);").editor), /editor .* failed/);
});

test("a run keeps its goal as goal.md", (t) => {
  const store = new RunStore(join(temporary(t), "run"));
  const state: RunState = {
    goal: "Create result.txt", project: store.directory, stage: "plan", iteration: 1,
    next_prompt: "Create result.txt", astra_model: "", claude_model: "", claude_effort: "", astra_effort: "",
    allowed_tools: "", max_iterations: 3, timeout: 10, plan: [], approved_tools: [],
  };
  store.create(state);
  assert.equal(readFileSync(store.goalPath, "utf8"), "Create result.txt\n");
  store.saveGoal("Create result.txt\n\nUser clarification:\nIn UTF-8");
  assert.equal(readFileSync(store.goalPath, "utf8"), "Create result.txt\n\nUser clarification:\nIn UTF-8\n");
});

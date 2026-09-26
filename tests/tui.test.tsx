import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import { App } from "../src/tui/App.js";
import { Feed, initialView, reduce } from "../src/tui/view.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("view tracks the active agent, per-agent activity and decisions", () => {
  let view = initialView("run-1", "/runs/run-1", { claude: "opus", astra: "CLI default model" });
  view = reduce(view, { type: "step", agent: "claude", task: "work", iteration: 1, maxIterations: 5 }, 1000);
  view = reduce(view, { type: "activity", agent: "claude", activity: { kind: "tool", text: "Bash npm test" } }, 1100);
  assert.deepEqual(view.active, { agent: "claude", task: "work", since: 1000 });
  assert.equal(view.lines.claude.length, 2);
  assert.equal(view.lines.astra.length, 0);
  view = reduce(view, { type: "step", agent: "astra", task: "review", iteration: 1, maxIterations: 5 }, 2000);
  const plan = [{ title: "Fix tests", done_when: "npm test passes", status: "pending" }] as const;
  view = reduce(view, { type: "decision", iteration: 1, review: { decision: "continue", reason: "tests fail", next_prompt: "fix", plan: [...plan] } }, 3000);
  view = reduce(view, { type: "plan", plan: [...plan] }, 3000);
  assert.equal(view.active, undefined);
  assert.equal(view.decisions.length, 1);
  assert.deepEqual(view.plan, plan);
});

test("TUI shows both agents' activity side by side and stops on q", async () => {
  const feed = new Feed(initialView("run-1", "/runs/run-1", { claude: "opus", astra: "CLI default model" }));
  let stops = 0;
  const app = render(<App feed={feed} onStop={() => stops++} onAnswer={() => {}} />);
  try {
    feed.dispatch({ type: "plan", plan: [
      { title: "Investigate", done_when: "findings recorded", status: "done" },
      { title: "Create result.txt", done_when: "result.txt exists", status: "pending" },
    ] });
    feed.dispatch({ type: "step", agent: "claude", task: "work", iteration: 1, maxIterations: 5 });
    feed.dispatch({ type: "activity", agent: "claude", activity: { kind: "tool", text: "Bash npm test" } });
    feed.dispatch({ type: "step", agent: "astra", task: "review", iteration: 1, maxIterations: 5 });
    feed.dispatch({ type: "activity", agent: "astra", activity: { kind: "text", text: "Verifying result.txt" } });
    feed.dispatch({ type: "decision", iteration: 1, review: { decision: "done", reason: "all checks pass", next_prompt: "", plan: [] } });
    await settle();
    const frame = app.lastFrame() ?? "";
    for (const expected of ["Claude Code  opus", "Astra (Codex)  CLI default model", "iteration 1/5", "stage 2/2 Create result.txt", "▸ Bash npm test", "● Verifying result.txt", "#1 done all checks pass"]) {
      assert.ok(frame.includes(expected), `missing ${expected}:\n${frame}`);
    }
    app.stdin.write("q");
    await settle();
    assert.equal(stops, 1);
    // Keys still work while stopping, so a second press can force the stop.
    feed.update((view) => ({ ...view, status: "stopping" }));
    await settle();
    assert.match(app.lastFrame() ?? "", /again: force/);
    app.stdin.write("\u0003");
    await settle();
    assert.equal(stops, 2);
  } finally {
    app.unmount();
  }
});

test("every row keeps the frame width whatever the agents print", async () => {
  const feed = new Feed(initialView("run-1", "/runs/run-1", { claude: "claude-opus-5-5", astra: "gpt-6-astra" }));
  const app = render(<App feed={feed} onStop={() => {}} onAnswer={() => {}} />);
  try {
    const awkward = [
      "1\t---\tfront matter",                         // tabs from Read output
      "\u001b[32m✓ 3 passed\u001b[0m in 1.2s",        // ANSI colours from test runners
      "⏺ done ⚠ careful ✔ ok ‼ ▶ play",               // symbols terminals may draw as emoji
      "日本語のテキスト — 矢印 → と省略…".repeat(4),     // wide and ambiguous characters, truncated
      "line one\r\nline two\u0007bell",               // carriage return and control characters
      `Read ${"/very/long/path".repeat(12)}`,          // truncated at the pane edge
    ];
    for (const text of awkward) {
      feed.dispatch({ type: "activity", agent: "claude", activity: { kind: "tool", text } });
      feed.dispatch({ type: "activity", agent: "astra", activity: { kind: "text", text } });
    }
    feed.dispatch({ type: "decision", iteration: 1, review: { decision: "continue", reason: "Tests fail:\n\tsee\tlog", next_prompt: "fix", plan: [] } });
    await settle();
    const rows = (app.lastFrame() ?? "").split("\n");
    const widths = new Set(rows.filter((row) => row.startsWith("│") || row.startsWith("╭") || row.startsWith("╰"))
      .map((row) => stringWidth(row)));
    assert.deepEqual([...widths], [100], `rows of unequal width:\n${rows.join("\n")}`);
    assert.ok(rows.every((row) => stringWidth(row) <= 100 && !row.includes("\t")));
  } finally {
    app.unmount();
  }
});

test("a permission request is shown until answered with y, a or n", async () => {
  const feed = new Feed(initialView("run-1", "/runs/run-1", { claude: "opus", astra: "gpt-6-astra" }));
  const answers: string[] = [];
  const app = render(<App feed={feed} onStop={() => {}} onAnswer={(answer) => answers.push(answer)} />);
  try {
    const request = { tool: "Bash", detail: "llvm-dwarfdump a.out", reason: "This command requires approval", rules: ["Bash(llvm-dwarfdump *)"] };
    feed.update((view) => ({ ...view, question: request }));
    await settle();
    const frame = app.lastFrame() ?? "";
    for (const expected of ["Claude asks to use Bash", "llvm-dwarfdump a.out", "This command requires approval", "a allow for this run: Bash(llvm-dwarfdump *)"]) {
      assert.ok(frame.includes(expected), `missing ${expected}:\n${frame}`);
    }
    for (const key of ["y", "a", "n", "x"]) {
      app.stdin.write(key);
      await settle();
    }
    assert.deepEqual(answers, ["once", "run", "deny"]);

    // Without a rule to remember, "a" is neither offered nor accepted.
    feed.update((view) => ({ ...view, question: { ...request, rules: [] } }));
    await settle();
    assert.doesNotMatch(app.lastFrame() ?? "", /allow for this run/);
    app.stdin.write("a");
    await settle();
    assert.deepEqual(answers, ["once", "run", "deny"]);
  } finally {
    app.unmount();
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { render } from "ink-testing-library";
import { App } from "../src/tui/App.js";
import { Feed, initialView, reduce } from "../src/tui/view.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("view tracks the active agent, per-agent activity and decisions", () => {
  let view = initialView("run-1", "/runs/run-1", { claude: "opus", astra: "CLI default model" });
  view = reduce(view, { type: "step", agent: "claude", iteration: 1, maxIterations: 5 }, 1000);
  view = reduce(view, { type: "activity", agent: "claude", activity: { kind: "tool", text: "Bash npm test" } }, 1100);
  assert.deepEqual(view.active, { agent: "claude", since: 1000 });
  assert.equal(view.lines.claude.length, 2);
  assert.equal(view.lines.astra.length, 0);
  view = reduce(view, { type: "step", agent: "astra", iteration: 1, maxIterations: 5 }, 2000);
  view = reduce(view, { type: "decision", iteration: 1, review: { decision: "continue", reason: "tests fail", next_prompt: "fix" } }, 3000);
  assert.equal(view.active, undefined);
  assert.equal(view.decisions.length, 1);
});

test("TUI shows both agents' activity side by side and stops on q", async () => {
  const feed = new Feed(initialView("run-1", "/runs/run-1", { claude: "opus", astra: "CLI default model" }));
  let stops = 0;
  const app = render(<App feed={feed} onStop={() => stops++} />);
  try {
    feed.dispatch({ type: "step", agent: "claude", iteration: 1, maxIterations: 5 });
    feed.dispatch({ type: "activity", agent: "claude", activity: { kind: "tool", text: "Bash npm test" } });
    feed.dispatch({ type: "step", agent: "astra", iteration: 1, maxIterations: 5 });
    feed.dispatch({ type: "activity", agent: "astra", activity: { kind: "text", text: "Verifying result.txt" } });
    feed.dispatch({ type: "decision", iteration: 1, review: { decision: "done", reason: "all checks pass", next_prompt: "" } });
    await settle();
    const frame = app.lastFrame() ?? "";
    for (const expected of ["Claude Code  opus", "Astra (Codex)  CLI default model", "iteration 1/5", "⏺ Bash npm test", "● Verifying result.txt", "#1 done all checks pass"]) {
      assert.ok(frame.includes(expected), `missing ${expected}:\n${frame}`);
    }
    app.stdin.write("q");
    await settle();
    assert.equal(stops, 1);
  } finally {
    app.unmount();
  }
});

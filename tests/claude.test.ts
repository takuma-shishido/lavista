import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { allowRules, BackgroundWork } from "../src/claude.js";

test("Claude's allow suggestions become --allowedTools rules", () => {
  assert.deepEqual(allowRules([
    { type: "addRules", behavior: "allow", destination: "localSettings", rules: [{ toolName: "Bash", ruleContent: "llvm-dwarfdump *" }, { toolName: "WebSearch" }] },
    { type: "addRules", behavior: "deny", destination: "session", rules: [{ toolName: "Bash", ruleContent: "rm *" }] },
    { type: "addDirectories", destination: "session", directories: ["/tmp"] },
  ]), ["Bash(llvm-dwarfdump *)", "WebSearch"]);
});

test("a step waits for background work Claude started, not for watchers the CLI started itself", () => {
  const work = new BackgroundWork();
  const system = (message: object) => ({ type: "system", uuid: "u", session_id: "s", ...message }) as unknown as SDKMessage;
  work.observe(system({ subtype: "task_started", task_id: "build", tool_use_id: "t1", description: "Build" }));
  work.observe(system({ subtype: "task_started", task_id: "watch", tool_use_id: "t2", description: "Watch build log" }));
  work.observe(system({ subtype: "background_tasks_changed", tasks: [
    { task_id: "build", task_type: "local_bash", description: "Build" },
    { task_id: "watch", task_type: "monitor", description: "Watch build log", ambient: true },
    { task_id: "auto", task_type: "monitor", description: "Auto watcher", ambient: true },
  ] }));
  assert.deepEqual(work.pending, ["Build", "Watch build log"]);
  work.observe(system({ subtype: "background_tasks_changed", tasks: [{ task_id: "auto", task_type: "monitor", description: "Auto watcher", ambient: true }] }));
  assert.deepEqual(work.pending, []);
});

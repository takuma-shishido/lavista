import assert from "node:assert/strict";
import { test } from "node:test";
import type { SDKMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { allowRules, BackgroundWork, ClaudeInput } from "../src/claude.js";
import { Inbox } from "../src/events.js";

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

test("text sent while Claude works follows the prompt, and a turn is still to come until a result consumes it", async () => {
  const input = new ClaudeInput("Fix the tests");
  const messages = input.messages();
  const next = async () => (await messages.next()).value as SDKUserMessage | undefined;
  assert.equal((await next())?.message.content, "Fix the tests");
  const waiting = next();
  input.send("Also run lint");
  const sent = await waiting;
  assert.equal(sent?.message.content, "Also run lint");
  assert.ok(sent?.uuid);
  assert.equal(input.waiting, true);

  const result = (fields: object) => ({ type: "result", subtype: "success", ...fields }) as unknown as SDKResultMessage;
  // The turn that was running when the text was sent did not take it.
  input.observe(result({ user_message_uuids: [] }));
  assert.equal(input.waiting, true);
  input.observe(result({ user_message_uuids: [sent!.uuid] }));
  assert.equal(input.waiting, false);

  // A CLI that does not report consumed messages is taken to have consumed them.
  input.send("And update the README");
  await next();
  input.observe(result({}));
  assert.equal(input.waiting, false);

  const ended = next();
  input.close();
  assert.equal(await ended, undefined);
});

test("the inbox delivers only while a step has it open", () => {
  const inbox = new Inbox();
  const received: string[] = [];
  assert.equal(inbox.send("early"), false);
  const close = inbox.open((text) => received.push(text));
  assert.equal(inbox.send("hello"), true);
  close();
  assert.equal(inbox.send("late"), false);
  assert.deepEqual(received, ["hello"]);
});

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionUpdate, SDKMessage, SDKUserMessage, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { execa } from "execa";
import type { ChildProcess } from "node:child_process";
import { open } from "node:fs/promises";
import { describeInput } from "./activity.js";
import type { AskPermission, PermissionAnswer } from "./events.js";
import type { ClaudeEffort } from "./model.js";
import { idleError, idleWatchdog, InterruptedError, track, writeTo } from "./process.js";

export interface ClaudeInvocation {
  prompt: string;
  cwd: string;
  sessionId: string;
  /** Empty: the CLI's own default. */
  model: string;
  effort: ClaudeEffort | "";
  /** Allow rules, each as `--allowedTools` accepts them (a config entry may hold several). */
  allowedTools: string[];
  eventsPath: string;
  stderrPath: string;
  /** Stop Claude once it has written nothing for this long, not counting time spent waiting for the user. */
  timeoutSeconds: number;
  signal: AbortSignal;
  /** Receives each event line (newline included) as it is written to `eventsPath`. */
  onLine?: (line: string) => void;
  /** The user approved these rules for the rest of the run. */
  onApprove?: (rules: string[]) => void;
}

export type ClaudeRunner = (invocation: ClaudeInvocation) => Promise<void>;

/** Allow rules in `--allowedTools` syntax, e.g. `Bash(npm test *)`, from Claude's own suggestions. */
export function allowRules(suggestions: PermissionUpdate[]): string[] {
  return suggestions.flatMap((update) => update.type === "addRules" && update.behavior === "allow"
    ? update.rules.map(({ toolName, ruleContent }) => (ruleContent ? `${toolName}(${ruleContent})` : toolName))
    : []);
}

/**
 * The SDK's view of an execa subprocess: streams and events are the Node child process's, while
 * `kill` goes through execa so it reaches the whole process group and escalates to SIGKILL.
 */
function spawned(subprocess: { nodeChildProcess: ChildProcess; kill(signal: NodeJS.Signals): boolean }): SpawnedProcess {
  const child = subprocess.nodeChildProcess;
  type Listener = Parameters<SpawnedProcess["on"]>[1];
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    get killed() { return child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (signal) => subprocess.kill(signal),
    on: (event: "exit" | "error", listener: Listener) => { child.on(event, listener); },
    once: (event: "exit" | "error", listener: Listener) => { child.once(event, listener); },
    off: (event: "exit" | "error", listener: Listener) => { child.off(event, listener); },
  } as SpawnedProcess;
}

/**
 * The background work (builds, subagents, monitors) Claude is still waiting on. A turn can end while
 * such work runs; the CLI starts another turn when it reports back, so a step is over only at a
 * result with none of it left. Watchers the CLI starts by itself (ambient, not from a tool call) are
 * not waited for: nothing in the step depends on them and some never end.
 */
export class BackgroundWork {
  private readonly requested = new Set<string>();
  private live: { task_id: string; description: string; ambient?: boolean }[] = [];

  observe(message: SDKMessage): void {
    if (message.type !== "system") return;
    if (message.subtype === "task_started" && message.tool_use_id) this.requested.add(message.task_id);
    if (message.subtype === "background_tasks_changed") this.live = message.tasks;
  }

  /** Descriptions of the work Claude will be woken up by. */
  get pending(): string[] {
    return this.live.filter((task) => !task.ambient || this.requested.has(task.task_id)).map((task) => task.description);
  }
}

/** Once the awaited work is gone, how long to wait for the turn it should start before ending the step. */
export const WAKE_GRACE_MS = 120_000;

/**
 * Run Claude Code through the Agent SDK so its permission prompts reach the user through `ask`
 * rather than being denied: a `-p` run has nobody to ask. Claude still runs as the `claude` CLI on
 * PATH, in auto mode, and its events are logged in the same stream-json form as `claude -p`.
 * The prompt is streamed and input stays open until the step is over, so background work that
 * outlives a turn can wake Claude again (a one-shot prompt would end the CLI after the first turn).
 */
export function sdkClaude(ask: AskPermission): ClaudeRunner {
  return async (invocation) => {
    const { prompt, cwd, sessionId, model, effort, allowedTools, eventsPath, stderrPath, timeoutSeconds, signal, onLine, onApprove } = invocation;
    signal.throwIfAborted();
    const events = await open(eventsPath, "w");
    const stderr = await open(stderrPath, "w");
    let writing = Promise.resolve();
    const log = (event: unknown) => {
      const line = `${JSON.stringify(event)}\n`;
      writing = writing.then(async () => { await events.write(line); });
      onLine?.(line);
    };
    let asking = 0;
    const background = new BackgroundWork();
    // Between a turn's result and the turn its background work starts; not counted as idle.
    let dormant = false;
    let grace: NodeJS.Timeout | undefined;
    // Set when the awaited work ended without starting another turn: the step is over, not stopped.
    let overWithoutWake = false;
    let closeInput = () => {};
    const inputClosed = new Promise<void>((resolve) => { closeInput = resolve; });
    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
      await inputClosed;
    }
    const idle = idleWatchdog([eventsPath, stderrPath], timeoutSeconds, () => asking > 0 || dormant);
    const abort = new AbortController();
    const stop = () => abort.abort();
    const stops = AbortSignal.any([signal, idle.signal]);
    stops.addEventListener("abort", stop, { once: true });

    const canUseTool: CanUseTool = async (tool, input, { signal: cancelled, suggestions = [], decisionReason }) => {
      const rules = allowRules(suggestions);
      let answer: PermissionAnswer;
      asking++;
      try {
        answer = await ask({ tool, detail: describeInput(input), reason: decisionReason, rules }, AbortSignal.any([cancelled, abort.signal]));
      } finally {
        asking--;
      }
      // Recorded with Claude's events, so a reviewer sees what the user decided.
      log({ type: "lavista_permission", tool, input, reason: decisionReason, answer });
      if (answer === "deny") return { behavior: "deny", message: "The user denied this action." };
      if (answer === "once") return { behavior: "allow", updatedInput: input };
      onApprove?.(rules);
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions.map((update) => ({ ...update, destination: "session" })) };
    };

    const stopped = () => {
      if (signal.aborted) return new InterruptedError();
      if (idle.signal.aborted) return idleError("claude", timeoutSeconds);
      return undefined;
    };
    try {
      const messages = query({
        prompt: input(),
        options: {
          cwd,
          sessionId,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          permissionMode: "auto",
          // Per-invocation rules only; Claude's own settings files are never modified.
          allowedTools,
          canUseTool,
          // Claude Code's own prompt and settings, as with `claude -p`; the SDK default is a bare prompt.
          systemPrompt: { type: "preset", preset: "claude_code" },
          pathToClaudeCodeExecutable: "claude",
          abortController: abort,
          spawnClaudeCodeProcess: ({ command, args, env }) => spawned(track(execa(command, args, {
            cwd, env, extendEnv: false,
            stdin: "pipe", stdout: "pipe", stderr: writeTo(stderr), buffer: false,
            // Signal the whole process group so stopping reaches the CLI's subprocesses as well.
            killDescendants: true, forceKillAfterDelay: 5000, reject: false,
          }))),
        },
      });
      for await (const message of messages) {
        log(message);
        background.observe(message);
        if (message.type === "assistant" || message.type === "user") {
          // The awaited work woke Claude for another turn.
          dormant = false;
          clearTimeout(grace);
          grace = undefined;
        } else if (message.type === "result") {
          const pending = background.pending;
          // Done: don't wait for output to end, which a daemonized descendant could hold open forever.
          if (message.is_error || pending.length === 0) break;
          dormant = true;
          log({ type: "lavista_waiting", tasks: pending });
        } else if (dormant && grace === undefined && background.pending.length === 0) {
          grace = setTimeout(() => {
            overWithoutWake = true;
            abort.abort();
          }, WAKE_GRACE_MS);
        }
      }
    } catch (error) {
      if (overWithoutWake && !stopped()) return;
      throw stopped() ?? new Error(`${error instanceof Error ? error.message : String(error)}\nSee ${stderrPath}`);
    } finally {
      clearTimeout(grace);
      closeInput();
      stops.removeEventListener("abort", stop);
      idle.stop();
      await writing;
      await events.close();
      await stderr.close();
    }
    const reason = stopped();
    if (reason) throw reason;
  };
}

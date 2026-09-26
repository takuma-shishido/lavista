import { Box, Text, useAnimation, useInput, useWindowSize } from "ink";
import { useSyncExternalStore } from "react";
import type { Activity } from "../activity.js";
import { displayText, formatActivity } from "../events.js";
import type { AgentName, PermissionAnswer, PermissionRequest } from "../events.js";
import type { Feed, View } from "./view.js";

const AGENTS: Record<AgentName, { title: string; color: string }> = {
  claude: { title: "Claude Code", color: "#d97757" },
  astra: { title: "Astra (Codex)", color: "cyan" },
};

const KIND_COLORS: Partial<Record<Activity["kind"], string>> = {
  info: "gray", tool: "yellow", output: "gray", error: "red", limit: "redBright",
};

function colorOf({ kind }: Activity): { color?: string } {
  const color = KIND_COLORS[kind];
  return color ? { color } : {};
}

const DECISION_COLORS = { continue: "yellow", done: "green", needs_input: "magenta" } as const;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function clock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function Working({ since }: { since: number }) {
  const { frame } = useAnimation({ interval: 100 });
  return <Text>{SPINNER[frame % SPINNER.length]} {clock(Date.now() - since)}</Text>;
}

/** The stage being worked on: the first pending one. */
function currentStage(view: View): string | undefined {
  const index = view.plan.findIndex((stage) => stage.status === "pending");
  return index < 0 ? undefined : `stage ${index + 1}/${view.plan.length} ${displayText(view.plan[index]!.title)}`;
}

function Header({ view }: { view: View }) {
  const stage = currentStage(view);
  return (
    <Box gap={2} overflow="hidden">
      <Text bold>lavista</Text>
      <Text dimColor>run {view.runId}</Text>
      {view.active?.task === "plan"
        ? <Text>planning</Text>
        : view.iteration > 0 && <Text>iteration {view.iteration}/{view.maxIterations}</Text>}
      {view.active && view.status === "running" && (
        <Text color={AGENTS[view.active.agent].color}>
          {AGENTS[view.active.agent].title} <Working since={view.active.since} />
        </Text>
      )}
      {stage && <Text wrap="truncate-end">{stage}</Text>}
    </Box>
  );
}

interface PaneProps {
  agent: AgentName;
  model: string;
  lines: Activity[];
  active: boolean;
  width: number;
  height: number;
}

function Pane({ agent, model, lines, active, width, height }: PaneProps) {
  const { title, color } = AGENTS[agent];
  // Rows inside the border, minus the title row.
  const capacity = Math.max(height - 3, 0);
  const first = Math.max(lines.length - capacity, 0);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={active ? color : "gray"}
      width={width} height={height} paddingX={1} overflow="hidden">
      <Text wrap="truncate-end"><Text bold color={color}>{title}</Text><Text dimColor>  {model}</Text></Text>
      {lines.slice(first).map((activity, index) => (
        <Text key={first + index} wrap="truncate-end" {...colorOf(activity)}
          dimColor={activity.kind === "thinking"} italic={activity.kind === "thinking"}>
          {formatActivity(activity)}
        </Text>
      ))}
    </Box>
  );
}

function Decisions({ view, limit }: { view: View; limit: number }) {
  return (
    <Box flexDirection="column">
      {view.decisions.slice(-limit).map(({ iteration, review }) => (
        <Text key={iteration} wrap="truncate-end">
          <Text color={DECISION_COLORS[review.decision]} bold>#{iteration} {review.decision}</Text>
          <Text> {displayText(review.reason)}</Text>
        </Text>
      ))}
    </Box>
  );
}

/** Rows the question box takes: border, title, detail, reason, keys. */
const QUESTION_ROWS = 6;

function Question({ request }: { request: PermissionRequest }) {
  const rules = request.rules.map(displayText).join(", ");
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} height={QUESTION_ROWS} overflow="hidden">
      <Text bold color="yellow" wrap="truncate-end">Claude asks to use {displayText(request.tool)}</Text>
      <Text wrap="truncate-end">{displayText(request.detail)}</Text>
      <Text dimColor wrap="truncate-end">{request.reason ? displayText(request.reason) : " "}</Text>
      <Text wrap="truncate-end">
        <Text bold>y</Text> allow once   {rules && <><Text bold>a</Text> allow for this run: {rules}   </>}<Text bold>n</Text> deny
      </Text>
    </Box>
  );
}

function Footer({ view }: { view: View }) {
  if (view.status === "stopping") return <Text color="yellow">Stopping… waiting for the agents to exit (q / Ctrl+C again: force)</Text>;
  if (view.notice) return <Text wrap="truncate-end">{displayText(view.notice)}</Text>;
  return <Text dimColor>q / Ctrl+C: stop (state and logs are kept; continue with `lavista resume`)</Text>;
}

const ANSWER_KEYS: Record<string, PermissionAnswer> = { y: "once", a: "run", n: "deny" };

export function App({ feed, onStop, onAnswer }: { feed: Feed; onStop: () => void; onAnswer: (answer: PermissionAnswer) => void }) {
  const view = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { columns, rows } = useWindowSize();
  // Stays active while stopping: raw mode must remain on, and a second press forces the stop.
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) return onStop();
    const answer = view.question && ANSWER_KEYS[input];
    // "a" is offered only when there is a rule to remember.
    if (answer && (answer !== "run" || view.question!.rules.length > 0)) onAnswer(answer);
  }, { isActive: view.status !== "stopped" });

  const decisionRows = Math.min(view.decisions.length, 3);
  const questionRows = view.question ? QUESTION_ROWS : 0;
  const bodyRows = Math.max(rows - 2 - decisionRows - questionRows, 8);
  const wide = columns >= 100;
  const paneWidth = wide ? Math.floor(columns / 2) : columns;
  const paneHeight = wide ? bodyRows : Math.floor(bodyRows / 2);

  return (
    <Box flexDirection="column" width={columns}>
      <Header view={view} />
      <Box flexDirection={wide ? "row" : "column"}>
        {(["claude", "astra"] as const).map((agent) => (
          <Pane key={agent} agent={agent} model={view.models[agent]} lines={view.lines[agent]} active={view.active?.agent === agent}
            width={paneWidth} height={paneHeight} />
        ))}
      </Box>
      <Decisions view={view} limit={decisionRows} />
      {view.question && <Question request={view.question} />}
      <Footer view={view} />
    </Box>
  );
}

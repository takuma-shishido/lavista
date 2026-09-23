import { Box, Text, useAnimation, useInput, useWindowSize } from "ink";
import { useSyncExternalStore } from "react";
import type { Activity } from "../activity.js";
import { formatActivity } from "../events.js";
import type { AgentName } from "../events.js";
import type { Feed, View } from "./view.js";

const AGENTS: Record<AgentName, { title: string; color: string }> = {
  claude: { title: "Claude Code", color: "#d97757" },
  astra: { title: "Astra (Codex)", color: "cyan" },
};

const KIND_COLORS: Partial<Record<Activity["kind"], string>> = {
  info: "gray", tool: "yellow", output: "gray", error: "red",
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

function Header({ view }: { view: View }) {
  return (
    <Box gap={2}>
      <Text bold>lavista</Text>
      <Text dimColor>run {view.runId}</Text>
      {view.iteration > 0 && <Text>iteration {view.iteration}/{view.maxIterations}</Text>}
      {view.active && view.status === "running" && (
        <Text color={AGENTS[view.active.agent].color}>
          {AGENTS[view.active.agent].title} <Working since={view.active.since} />
        </Text>
      )}
    </Box>
  );
}

interface PaneProps {
  agent: AgentName;
  lines: Activity[];
  active: boolean;
  width: number;
  height: number;
}

function Pane({ agent, lines, active, width, height }: PaneProps) {
  const { title, color } = AGENTS[agent];
  // Rows inside the border, minus the title row.
  const capacity = Math.max(height - 3, 0);
  const first = Math.max(lines.length - capacity, 0);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={active ? color : "gray"}
      width={width} height={height} paddingX={1} overflow="hidden">
      <Text bold color={color}>{title}</Text>
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
          <Text> {review.reason}</Text>
        </Text>
      ))}
    </Box>
  );
}

function Footer({ view }: { view: View }) {
  if (view.status === "stopping") return <Text color="yellow">Stopping… waiting for the agents to exit</Text>;
  if (view.notice) return <Text wrap="truncate-end">{view.notice}</Text>;
  return <Text dimColor>q / Ctrl+C: stop (state and logs are kept; continue with `lavista resume`)</Text>;
}

export function App({ feed, onStop }: { feed: Feed; onStop: () => void }) {
  const view = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const { columns, rows } = useWindowSize();
  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) onStop();
  }, { isActive: view.status === "running" });

  const decisionRows = Math.min(view.decisions.length, 3);
  const bodyRows = Math.max(rows - 2 - decisionRows, 8);
  const wide = columns >= 100;
  const paneWidth = wide ? Math.floor(columns / 2) : columns;
  const paneHeight = wide ? bodyRows : Math.floor(bodyRows / 2);

  return (
    <Box flexDirection="column" width={columns}>
      <Header view={view} />
      <Box flexDirection={wide ? "row" : "column"}>
        {(["claude", "astra"] as const).map((agent) => (
          <Pane key={agent} agent={agent} lines={view.lines[agent]} active={view.active?.agent === agent}
            width={paneWidth} height={paneHeight} />
        ))}
      </Box>
      <Decisions view={view} limit={decisionRows} />
      <Footer view={view} />
    </Box>
  );
}

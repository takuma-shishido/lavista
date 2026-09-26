import { input, select } from "@inquirer/prompts";
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import type { AgentName } from "./events.js";
import { CLAUDE_EFFORTS } from "./model.js";
import type { ModelSettings } from "./model.js";
import { DEFAULT_SETTINGS } from "./workspace.js";

export interface Choice {
  value: string;
  description?: string;
}

export interface ModelOption extends Choice {
  /** Reasoning levels this model accepts; unknown when absent. */
  efforts?: Choice[];
  defaultEffort?: string;
}

/**
 * Claude Code has no model listing command, and its aliases (`opus`, `fable`) can resolve to an
 * older model than the newest one, so full model names are offered.
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-fable-5-1", description: "Fable 5.1 — most capable" },
  { value: "claude-opus-5-5", description: "Opus 5.5" },
  { value: "claude-sonnet-5", description: "Sonnet 5 — efficient for everyday tasks" },
  { value: "claude-haiku-4-5-20251001", description: "Haiku 4.5 — fastest" },
];

const CLAUDE_EFFORT_CHOICES: Choice[] = CLAUDE_EFFORTS.map((value) => ({ value }));

const codexCatalog = z.object({ models: z.array(z.unknown()) });

const codexModel = z.object({
  slug: z.string(),
  description: z.string().nullish(),
  visibility: z.string().nullish(),
  default_reasoning_level: z.string().nullish(),
  supported_reasoning_levels: z.array(z.object({ effort: z.string(), description: z.string().nullish() })).nullish(),
});

const withDescription = (value: string, description: string | null | undefined): Choice =>
  description ? { value, description } : { value };

/** Models Codex offers in its own picker, from `codex debug models` or its cached catalog. */
export function parseCodexCatalog(json: string): ModelOption[] {
  let entries: unknown[];
  try {
    entries = codexCatalog.parse(JSON.parse(json)).models;
  } catch {
    return [];
  }
  // Validate entries one by one so a single unexpected entry does not hide the rest.
  return entries.flatMap((entry) => {
    const model = codexModel.safeParse(entry);
    if (!model.success || model.data.visibility === "hide") return [];
    const { slug, description, supported_reasoning_levels: levels, default_reasoning_level: defaultEffort } = model.data;
    return [{
      ...withDescription(slug, description),
      ...(levels ? { efforts: levels.map((level) => withDescription(level.effort, level.description)) } : {}),
      ...(defaultEffort ? { defaultEffort } : {}),
    }];
  });
}

/**
 * The account's cached catalog (fetched by Codex from the server, so it includes models newer
 * than the CLI build) followed by the CLI's built-in catalog. Either may be missing.
 */
export async function codexModels(): Promise<ModelOption[]> {
  const cache = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
  const cached = existsSync(cache) ? parseCodexCatalog(readFileSync(cache, "utf8")) : [];
  const builtIn = await execa("codex", ["debug", "models"], { stdin: "ignore", reject: false, timeout: 15_000 });
  const models = [...cached, ...(builtIn.failed ? [] : parseCodexCatalog(builtIn.stdout))];
  return models.filter((model, index) => models.findIndex((other) => other.value === model.value) === index);
}

/** Effort levels to offer for a model: its own list, or every level known for that agent. */
export function effortChoices(agent: AgentName, model: string, catalog: ModelOption[]): Choice[] {
  if (agent === "claude") return CLAUDE_EFFORT_CHOICES;
  const known = catalog.find((option) => option.value === model)?.efforts;
  if (known) return known;
  const all = catalog.flatMap((option) => option.efforts ?? []);
  return all.filter((choice, index) => all.findIndex((other) => other.value === choice.value) === index);
}

const AGENT_NAMES: Record<AgentName, string> = { claude: "Claude (worker)", astra: "Astra / Codex (reviewer)" };
const CLI_DEFAULT = "";
const OTHER = "\u0000other";

/** A list with the CLI's default first; `allowOther` adds free input. */
async function ask(message: string, cli: string, choices: Choice[], allowOther: boolean, initial = CLI_DEFAULT): Promise<string> {
  const choice = await select({
    message,
    choices: [
      { value: CLI_DEFAULT, name: "CLI default", description: `Whatever ${cli} is configured to use (nothing is passed)` },
      ...choices.map((option) => ({ ...option, name: option.value })),
      ...(allowOther ? [{ value: OTHER, name: "Other…", description: "Type a name" }] : []),
    ],
    default: choices.some((choice) => choice.value === initial) ? initial : CLI_DEFAULT,
    pageSize: 12,
  });
  if (choice !== OTHER) return choice;
  return (await input({ message: `${message} name`, required: true })).trim();
}

export interface ModelPicker {
  model(agent: AgentName): Promise<string>;
  effort(agent: AgentName, model: string): Promise<string>;
}

export function interactivePicker(): ModelPicker {
  // Fetched on the first question (usually Claude's), so it is ready by Astra's; never when nothing is asked.
  let codex: Promise<ModelOption[]> | undefined;
  const catalog = (agent: AgentName) => {
    codex ??= codexModels().catch(() => []);
    return agent === "claude" ? Promise.resolve(CLAUDE_MODELS) : codex;
  };
  const cli = (agent: AgentName) => (agent === "claude" ? "claude" : "codex");
  return {
    model: async (agent) =>
      ask(`${AGENT_NAMES[agent]} model`, cli(agent), await catalog(agent), true, DEFAULT_SETTINGS[`${agent}_model`]),
    effort: async (agent, model) => {
      const models = await catalog(agent);
      const modelDefault = models.find((option) => option.value === model)?.defaultEffort;
      const choices = effortChoices(agent, model, models).map((choice) => choice.value === modelDefault
        ? { ...choice, description: [choice.description, "(model default)"].filter(Boolean).join(" ") }
        : choice);
      return ask(`${AGENT_NAMES[agent]} effort`, cli(agent), choices, false);
    },
  };
}

type Given = { [Key in keyof ModelSettings]?: string | undefined };

function claudeEffort(value: string): ModelSettings["claude_effort"] {
  const effort = CLAUDE_EFFORTS.find((level) => level === value);
  if (value !== "" && effort === undefined) throw new Error(`Claude effort must be one of: ${CLAUDE_EFFORTS.join(", ")}`);
  return effort ?? "";
}

/**
 * Each value given on the command line or in config wins; the rest are picked
 * (model, then its effort, per agent), or left to the CLI defaults without a picker.
 */
export async function chooseModels(given: Given, picker?: ModelPicker): Promise<ModelSettings> {
  const choose = async (value: string | undefined, fallback: string, pick: (picker: ModelPicker) => Promise<string>) =>
    value ?? (picker ? await pick(picker) : fallback);
  const claude_model = await choose(given.claude_model, DEFAULT_SETTINGS.claude_model, (p) => p.model("claude"));
  const claude_effort = await choose(given.claude_effort, DEFAULT_SETTINGS.claude_effort, (p) => p.effort("claude", claude_model));
  const astra_model = await choose(given.astra_model, DEFAULT_SETTINGS.astra_model, (p) => p.model("astra"));
  const astra_effort = await choose(given.astra_effort, DEFAULT_SETTINGS.astra_effort, (p) => p.effort("astra", astra_model));
  return { claude_model, claude_effort: claudeEffort(claude_effort), astra_model, astra_effort };
}

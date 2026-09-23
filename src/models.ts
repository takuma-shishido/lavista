import { input, select } from "@inquirer/prompts";
import { execa } from "execa";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentName } from "./events.js";
import type { ModelSettings } from "./model.js";
import { DEFAULT_SETTINGS } from "./workspace.js";

export interface ModelOption {
  value: string;
  description?: string;
}

/** Claude Code has no model listing command; these are the aliases `claude --model` resolves to the latest models. */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "fable", description: "Latest Fable" },
  { value: "opus", description: "Latest Opus" },
  { value: "sonnet", description: "Latest Sonnet" },
  { value: "haiku", description: "Latest Haiku" },
];

const codexCatalog = z.object({ models: z.array(z.unknown()) });

const codexModel = z.object({
  slug: z.string(),
  description: z.string().nullish(),
  visibility: z.string().nullish(),
});

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
    const { slug, description } = model.data;
    return [description ? { value: slug, description } : { value: slug }];
  });
}

/**
 * The account's cached catalog (fetched by Codex from the server, so it includes models newer
 * than the CLI build) followed by the CLI's built-in catalog. Either may be missing.
 */
export async function codexModels(): Promise<ModelOption[]> {
  const cache = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json");
  const cached = existsSync(cache) ? parseCodexCatalog(readFileSync(cache, "utf8")) : [];
  const builtIn = await execa("codex", ["debug", "models"], { reject: false, timeout: 15_000 });
  const models = [...cached, ...(builtIn.failed ? [] : parseCodexCatalog(builtIn.stdout))];
  return models.filter((model, index) => models.findIndex((other) => other.value === model.value) === index);
}

const AGENT_NAMES: Record<AgentName, string> = { claude: "Claude (worker)", astra: "Astra / Codex (reviewer)" };
const CLI_DEFAULT = "";
const OTHER = "\u0000other";

/** Ask for one agent's model from a list, with the CLI's default and free input as extra choices. */
export async function askModel(agent: AgentName, options: ModelOption[], fallback: string): Promise<string> {
  const name = AGENT_NAMES[agent];
  const choice = await select({
    message: `${name} model`,
    choices: [
      { value: CLI_DEFAULT, name: "CLI default", description: `Whatever ${agent === "claude" ? "claude" : "codex"} is configured to use` },
      ...options.map((option) => ({ ...option, name: option.value })),
      { value: OTHER, name: "Other…", description: "Type a model name" },
    ],
    default: options.some((option) => option.value === fallback) ? fallback : CLI_DEFAULT,
    pageSize: 12,
  });
  if (choice !== OTHER) return choice;
  return (await input({ message: `${name} model name`, required: true })).trim();
}

export type ModelPicker = (agent: AgentName) => Promise<string>;

export const interactivePicker: ModelPicker = async (agent) => agent === "claude"
  ? askModel("claude", CLAUDE_MODELS, DEFAULT_SETTINGS.claude_model)
  : askModel("astra", await codexModels(), DEFAULT_SETTINGS.astra_model);

/** Models given on the command line or in config win; the rest are picked, or defaulted without a picker. */
export async function chooseModels(
  given: { [Key in keyof ModelSettings]?: string | undefined },
  pick?: ModelPicker,
): Promise<ModelSettings> {
  const choose = async (agent: AgentName, value: string | undefined, fallback: string) =>
    value ?? (pick ? await pick(agent) : fallback);
  return {
    claude_model: await choose("claude", given.claude_model, DEFAULT_SETTINGS.claude_model),
    astra_model: await choose("astra", given.astra_model, DEFAULT_SETTINGS.astra_model),
  };
}

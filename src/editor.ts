import { execa } from "execa";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Everything from this line down is help for the user and is not kept, as in `git commit -v`. */
export const SCISSORS = "# ------------------------ >8 ------------------------";

/** The user's editor, as git picks it: `$VISUAL`, then `$EDITOR`, then vi. */
export function editorCommand(env: NodeJS.ProcessEnv = process.env): string {
  return env.VISUAL || env.EDITOR || "vi";
}

/**
 * Let the user write text in their editor, starting from `initial`, with `help` shown below the
 * scissors line. Returns what is above that line, trimmed; empty when the user wrote nothing.
 * The file lives in a temporary directory, so nothing is left in the project.
 */
export async function editText(initial: string, help: string, editor = editorCommand()): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), "lavista-"));
  const path = join(directory, "goal.md");
  try {
    const comments = help.split("\n").map((line) => `# ${line}`.trimEnd()).join("\n");
    writeFileSync(path, `${initial.trim()}\n\n${SCISSORS}\n${comments}\n`);
    // Through the shell, so an editor with arguments such as `code --wait` works as it does for git.
    await execa("sh", ["-c", `${editor} "$1"`, "sh", path], { stdio: "inherit" }).catch((error: unknown) => {
      throw new Error(`The editor (${editor}) failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const text = readFileSync(path, "utf8");
    const cut = text.split("\n").indexOf(SCISSORS);
    return (cut === -1 ? text : text.split("\n").slice(0, cut).join("\n")).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

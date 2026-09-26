import { execa } from "execa";

/**
 * Get the user's attention while they may be looking elsewhere: the terminal bell, and on macOS a
 * desktop notification. Best effort; a failure is ignored.
 */
export function notify(message: string, write: (text: string) => void = (text) => process.stdout.write(text)): void {
  write("\u0007");
  if (process.platform !== "darwin") return;
  // AppleScript string literals share JSON's quoting and escapes.
  execa("osascript", ["-e", `display notification ${JSON.stringify(message)} with title "lavista"`]).catch(() => {});
}

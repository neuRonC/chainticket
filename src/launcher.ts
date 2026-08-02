#!/usr/bin/env -S npx tsx
/**
 * A thin launcher: pick a role, and it spawns that role's own script as a
 * separate process (`npm run <role>`) so the session behaves exactly as if
 * it had been started on its own - CTRL+C, prompts, and process.exit() all
 * belong to the child, not this launcher. When the child exits, control
 * returns here to pick another role.
 *
 * Run directly from the project root: `./src/launcher.ts` (or
 * `npm run start`).
 */

import { spawn } from "node:child_process";
import * as ui from "./ui";

const ROLES: { name: string; script: string }[] = [
  { name: "Login as Organizer", script: "organizer" },
  { name: "Login as User", script: "user" },
  { name: "Login as Validator", script: "validator" },
  { name: "Audit", script: "audit" },
];

function run(script: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", script], { stdio: "inherit" });
    child.on("exit", () => resolve());
  });
}

async function main() {
  ui.showStartup("ChainTicket");

  for (;;) {
    const script = await ui.askAction<string | null>("Select an option:", [
      ...ROLES.map((r) => ({ name: r.name, value: r.script })),
      { name: "Exit", value: null },
    ]);
    if (!script) break;
    console.log();
    await run(script);
    console.log();
  }
}

// CTRL+C at the role picker exits quietly instead of dumping a stack.
main().catch((error) => {
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(0);
  throw error;
});

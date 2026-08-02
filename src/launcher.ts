#!/usr/bin/env -S npx tsx
/**
 * A thin launcher: pick a role, and it spawns that role's own script as a separate process.
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

main().catch((error) => {
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(0);
  throw error;
});

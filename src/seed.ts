/**
 * One-command demo staging: wipe the database, deploy the EventFactory
 * (via deployPlatform, which also provisions the platform account), and
 * add the demo users (org/user1/user2/user3/val) on top.
 *
 * Run once after starting anvil (`npm run seed`). Re-running is a full
 * reset - a fresh factory makes every previously indexed event stale, so
 * the database goes with it.
 */

import { rmSync } from "node:fs";
import { loadConfig } from "./config";
import { connect } from "./chain";
import { openDatabase } from "./db";
import { provisionUsers } from "./auth";
import { deployPlatform } from "./deploy";
import * as ui from "./ui";

async function main() {
  const config = loadConfig();
  const chain = connect(config);

  ui.showStartup("Seed");

  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(config.databasePath + suffix, { force: true });
  }

  const factory = await deployPlatform(chain, config);
  ui.showSuccess(`EventFactory deployed: ${factory}`);

  const db = openDatabase(config.databasePath);
  provisionUsers(db, config);
  ui.showSuccess(`Demo users created: ${Object.keys(config.accounts).filter((n) => n !== "platform").join(", ")}`);
  db.close();

  process.exit(0);
}

main();

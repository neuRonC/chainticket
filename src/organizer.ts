/**
 * The organiser's program.
 */

import type { Address } from "viem";
import { loadConfig } from "./config";
import { connect } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase, type EventRow } from "./db";
import { login, usernameOf } from "./auth";
import {
  authorizeValidator,
  closeEvent,
  createEvent,
  holdsTicket,
  isValidatorOn,
  releaseTickets,
  revokeValidator,
} from "./ticketing";
import * as ui from "./ui";

async function main() {
  const config = loadConfig();
  const chain = connect(config);
  const db = openDatabase(config.databasePath);
  const { factory } = requireFactory();

  ui.showStartup("Organizer");

  const credentials = await ui.askLogin();
  const session = login(db, credentials.username, credentials.password);
  if (!session) {
    ui.showFailure("Invalid account details");
    process.exit(1);
  }

  // Minutes of human time -> an absolute block number.
  const toBlocks = (minutes: number, from: bigint) =>
    from + BigInt(Math.ceil((minutes * 60) / config.blockSeconds));

  // Pick from labelled events (empty list => info message).
  async function pick(message: string, events: EventRow[], block: number) {
    if (events.length === 0) {
      ui.showFailure("No matching events.");
      return null;
    }
    return ui.askEvent(
      message,
      events.map((row) => ({
        row,
        label: `#${row.event_id} ${row.name} · ${ui.eventPhase(row, block, config.blockSeconds)} · released ${row.released}/${row.capacity} · sold ${row.sold} · price ${ui.eth(row.price_wei)}`,
      })),
    );
  }

  for (;;) {
    const balance = await chain.getBalance(session.address);
    ui.showIdentity(session.username, session.address, balance);
    console.log();

    const action = await ui.askAction("Action:", [
      { name: "Create event", value: "create" },
      { name: "Manage event", value: "manage" },
      { name: "Refresh", value: "refresh" },
      { name: "Exit", value: "exit" },
    ]);
    if (action === "exit") break;

    try {
      if (action === "create") {
        const name = await ui.askText("Event name:");
        const capacity = await ui.askPositiveInt("Total ticket supply:");
        const priceWei = await ui.askEth("Price (ETH):");
        const resaleCapWei = await ui.askEth("Resale price cap (ETH):");

        const entryMinutes = await ui.askPositiveInt("Event entry time (mins afterwards):");
        let endMinutes: number;
        for (;;) {
          endMinutes = await ui.askPositiveInt("Event end time (mins afterwards):");
          if (endMinutes > entryMinutes) break;
          ui.showFailure("End time must be later than entry time");
        }
        const now = await chain.publicClient.getBlockNumber();
        const entryBlock = toBlocks(entryMinutes, now);
        const endBlock = toBlocks(endMinutes, now);

        const { eventId, contract } = await createEvent(
          chain,
          factory,
          session.privateKey,
          name,
          BigInt(capacity),
          priceWei,
          resaleCapWei,
          entryBlock,
          endBlock,
        );
        for (let i = 0; i < 20 && !db.getEvent(Number(eventId)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!db.getEvent(Number(eventId))) {
          ui.showFailure(
            `Event #${eventId} created on-chain (${contract}), but the indexer hasn't indexed it yet - make sure "npm run indexer" is running against this deployment.`,
          );
        } else {
          ui.showSuccess(`✔ Event #${eventId} "${name}" created`);
        }
      } else if (action === "manage") {
        for (;;) {
          const myEvents = db.listEventsByOrganiser(session.address);
          if (myEvents.length === 0) {
            ui.showFailure("You have no events yet.");
            break;
          }
          const pickBlock = Number(await chain.publicClient.getBlockNumber());
          const ev = await pick("Select event to manage:", myEvents, pickBlock);
          if (!ev) break;
          if (ev.closed || pickBlock >= ev.end_block) {
            ui.showFailure("This event has ended - use the Audit interface to look it up.");
            continue;
          }

          try {
            for (;;) {
              const freshEv = db.getEvent(ev.event_id)!;
              const currentBlock = Number(await chain.publicClient.getBlockNumber());

              const sub = await ui.askAction("Manage event:", [
                { name: "Release tickets", value: "release" },
                { name: "Manage validator", value: "validator" },
                { name: "Close event", value: "close" },
                { name: "<- Back", value: "back" },
              ]);
              if (sub === "back") break;

              try {
                if (sub === "release") {
                  if (freshEv.closed || currentBlock >= freshEv.entry_block) {
                    ui.showFailure("Sales are closed for this event.");
                    continue;
                  }
                  const count = await ui.askPositiveInt(
                    `How many tickets to release (remaining ${freshEv.capacity - freshEv.released}):`,
                  );
                  const sure = await ui.askConfirm(`Release ${count} tickets. Confirm?`);
                  if (!sure) continue;
                  await releaseTickets(chain, freshEv.contract as Address, session.privateKey, BigInt(count));
                  ui.showSuccess(`✔ Released ${count} tickets`);
                } else if (sub === "validator") {
                  for (;;) {
                    const validators = db.listValidators(freshEv.event_id);
                    ui.showInfo("[Validators]");
                    for (const v of validators) {
                      const isOrganiser = v.address.toLowerCase() === freshEv.organiser.toLowerCase();
                      ui.showInfo(`  ${usernameOf(db, v.address) ?? v.address}${isOrganiser ? " (organiser)" : ""}`);
                    }
                    console.log();

                    const vsub = await ui.askAction("Manage validator:", [
                      { name: "Authorize validator", value: "authorize" },
                      { name: "Unauthorize validator", value: "unauthorize" },
                      { name: "<- Back", value: "back" },
                    ]);
                    if (vsub === "back") break;

                    try {
                      if (vsub === "authorize") {
                        if (freshEv.closed || currentBlock >= freshEv.end_block) {
                          ui.showFailure("This event is over - new validators cannot be authorised.");
                          continue;
                        }
                        // Re-prompt until a valid, distinct candidate is given.
                        let user;
                        for (;;) {
                          const username = await ui.askText("Validator username:");
                          user = db.getUser(username);
                          if (!user) {
                            ui.showFailure(`No such user: ${username}`);
                            continue;
                          }
                          if (await isValidatorOn(chain, freshEv.contract as Address, user.address as Address)) {
                            ui.showFailure(`${username} is already a validator for this event`);
                            user = undefined;
                            continue;
                          }
                          if (await holdsTicket(chain, freshEv.contract as Address, user.address as Address)) {
                            ui.showFailure(`${username} holds a ticket for this event and cannot be authorised as a validator`);
                            user = undefined;
                            continue;
                          }
                          break;
                        }
                        await authorizeValidator(
                          chain,
                          freshEv.contract as Address,
                          session.privateKey,
                          user.address as Address,
                        );
                        ui.showSuccess(`✔ Authorized ${user.username} as a validator for event #${freshEv.event_id}`);
                      } else if (vsub === "unauthorize") {
                        const revocable = validators.filter(
                          (v) => v.address.toLowerCase() !== freshEv.organiser.toLowerCase(),
                        );
                        if (revocable.length === 0) {
                          ui.showFailure("No validators to unauthorize.");
                          continue;
                        }
                        const target = await ui.askAction("Select validator to unauthorize:", [
                          ...revocable.map((v) => ({
                            name: usernameOf(db, v.address) ?? v.address,
                            value: v.address as Address | null,
                          })),
                          { name: "<- Back", value: null },
                        ]);
                        if (!target) continue;
                        const sure = await ui.askConfirm(`Unauthorize ${usernameOf(db, target) ?? target}?`);
                        if (!sure) continue;
                        await revokeValidator(chain, freshEv.contract as Address, session.privateKey, target);
                        ui.showSuccess(`✔ Unauthorized ${usernameOf(db, target) ?? target}`);
                      }
                    } catch (error) {
                      if (ui.isCancel(error)) continue;
                      ui.showError(error);
                    }
                  }
                } else if (sub === "close") {
                  if (freshEv.closed || currentBlock >= freshEv.end_block) {
                    ui.showFailure("This event is already closed or has ended.");
                    continue;
                  }
                  const beforeEntry = currentBlock < freshEv.entry_block;
                  const sure = await ui.askConfirm(
                    beforeEntry
                      ? `The event has not reached its scheduled end time. Closing early opens full refunds for everyone. Confirm?`
                      : `⚠ Close event #${freshEv.event_id}: revenue from checked-in tickets settles to you, unused tickets become refundable. Confirm?`,
                  );
                  if (!sure) continue;
                  await closeEvent(chain, freshEv.contract as Address, session.privateKey);
                  ui.showSuccess(`✔ Event #${freshEv.event_id} closed, refunds are now open`);
                }
              } catch (error) {
                if (ui.isCancel(error)) continue;
                ui.showError(error);
              }
            }
          } catch (error) {
            if (ui.isCancel(error)) continue;
          }
        }
      }
    } catch (error) {
      if (ui.isCancel(error)) continue;
      ui.showError(error);
    }
  }

  db.close();
  process.exit(0);
}

main().catch((error) => {
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(0);
  throw error;
});

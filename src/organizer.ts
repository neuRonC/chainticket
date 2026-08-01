/**
 * The organiser's program.
 *
 * Login first; the contracts enforce that only the organiser of an event
 * may manage it. Creating an event deploys a fresh EventTicket contract
 * through the factory with block-number timing (entry and end). Tickets go
 * on sale in batches (releaseTickets); whoever sends a transaction pays its
 * own gas, no deposit required. The organiser is automatically a validator,
 * may authorise more until the event ends, and can close early (opening
 * refunds); normally-ended events are settled automatically by the
 * platform's keeper.
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
        label: `#${row.event_id} ${row.name} · ${ui.eventPhase(row, block, config.blockSeconds)} · released ${row.released}/${row.capacity} · sold ${row.sold}`,
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
        // Give the indexer a moment to pick the event up before a later
        // menu, which reads only the local database, looks for it.
        for (let i = 0; i < 20 && !db.getEvent(Number(eventId)); i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        if (!db.getEvent(Number(eventId))) {
          ui.showFailure(
            `Event #${eventId} created on-chain (${contract}), but the indexer hasn't indexed it yet - make sure "npm run indexer" is running against this deployment.`,
          );
        } else {
          ui.showSuccess(
            `✔ Event #${eventId} "${name}" created (entry block ${entryBlock} · end block ${endBlock}), use "Manage event" to release tickets`,
          );
        }
      } else if (action === "manage") {
        // Level A: repeatedly pick an event to manage. Only backing out
        // here (CTRL+C or "<- Back") returns to the main menu.
        for (;;) {
          const myEvents = db.listEventsByOrganiser(session.address);
          if (myEvents.length === 0) {
            ui.showFailure("You have no events yet.");
            break;
          }
          const pickBlock = Number(await chain.publicClient.getBlockNumber());
          const ev = await pick("Select event to manage:", myEvents, pickBlock);
          if (!ev) break;

          // Level B: the action menu for this one event. A CTRL+C at its
          // own prompt is caught here, landing back on "Select event to
          // manage:" instead of the main menu.
          try {
            for (;;) {
              const freshEv = db.getEvent(ev.event_id)!;
              const currentBlock = Number(await chain.publicClient.getBlockNumber());
              ui.showInfo(`[Event #${freshEv.event_id} ${freshEv.name}]`);
              ui.showEventRow(freshEv, currentBlock, config.blockSeconds);
              console.log();

              const sub = await ui.askAction("Manage event:", [
                { name: "Release tickets", value: "release" },
                { name: "Manage validator", value: "validator" },
                { name: "Close event", value: "close" },
                { name: "<- Back", value: "back" },
              ]);
              if (sub === "back") break;

              // Level C: one action's own detail entry. A CTRL+C here is
              // caught right below, landing back on "Manage event:".
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
                  // Level D: authorize/unauthorize. A CTRL+C at its own
                  // prompt is caught here, landing back on "Manage event:".
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

                    // Level E: this specific validator action's own detail
                    // entry. A CTRL+C here lands back on "Manage validator:".
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
                      if (ui.isCancel(error)) continue; // CTRL+C mid-entry: back to "Manage validator:"
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
                if (ui.isCancel(error)) continue; // CTRL+C mid-entry: back to "Manage event:"
                ui.showError(error);
              }
            }
          } catch (error) {
            if (ui.isCancel(error)) continue; // CTRL+C at "Manage event:": back to "Select event to manage:"
            ui.showError(error);
          }
        }
      }
    } catch (error) {
      if (ui.isCancel(error)) continue; // CTRL+C inside "create": back to the main menu
      ui.showError(error);
    }
  }

  db.close();
  process.exit(0);
}

// CTRL+C at a top-level prompt exits quietly instead of dumping a stack.
main().catch((error) => {
  if (error instanceof Error && error.name === "ExitPromptError") process.exit(0);
  throw error;
});

/**
 * The validator's program - the human oracle at the gate (FR3).
 */

import type { Address } from "viem";
import { loadConfig } from "./config";
import { connect } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase, type EventRow } from "./db";
import { login, usernameOf } from "./auth";
import { isValidatorOn, markUsed } from "./ticketing";
import * as ui from "./ui";

async function main() {
  const config = loadConfig();
  const chain = connect(config);
  const db = openDatabase(config.databasePath);
  requireFactory();

  ui.showStartup("Validator");

  const credentials = await ui.askLogin();
  const session = login(db, credentials.username, credentials.password);
  if (!session) {
    ui.showFailure("Invalid account details");
    process.exit(1);
  }

  // Authorisation is on-chain and per-event: ask each event's contract.
  const authorised: EventRow[] = [];
  for (const ev of db.listEvents()) {
    if (ev.closed) continue;
    if (await isValidatorOn(chain, ev.contract as Address, session.address)) {
      authorised.push(ev);
    }
  }
  if (authorised.length === 0) {
    ui.showFailure("You are not authorised as a validator for any event");
    process.exit(1);
  }
  ui.showSuccess(
    `Welcome ${session.username} · authorised for: ${authorised.map((e) => `#${e.event_id} ${e.name}`).join(", ")}\n`,
  );

  const startBlock = Number(await chain.publicClient.getBlockNumber());
  const ev = await ui.askEvent(
    "Select event to validate:",
    authorised.map((row) => ({
      row,
      label: `#${row.event_id} ${row.name} · ${ui.eventPhase(row, startBlock, config.blockSeconds)}`,
    })),
  );
  if (!ev) process.exit(0);
  const contract = ev.contract as Address;
  ui.showInfo(`\n-- Check-in desk · Event #${ev.event_id} ${ev.name} --`);

  for (;;) {
    const currentBlock = Number(await chain.publicClient.getBlockNumber());
    const balance = await chain.getBalance(session.address);
    ui.showIdentity(session.username, session.address, balance);
    ui.showInfo(`Current status: ${ui.eventPhase(db.getEvent(ev.event_id)!, currentBlock, config.blockSeconds)}`);

    const action = await ui.askAction("Action:", [
      { name: "Validate ticket", value: "checkin" },
      { name: "Refresh", value: "refresh" },
      { name: "Exit", value: "exit" },
    ]);
    if (action === "exit") break;

    try {
      if (action === "checkin") {
        if (currentBlock < ev.entry_block) {
          ui.showFailure("Entry has not opened yet for this event.");
          continue;
        }
        for (;;) {
          const query = await ui.askText("Ticket ID or @username:");

          try {
            // Resolve @username to that user's tickets for this event.
            let ticketId: number | undefined;
            if (query.startsWith("@")) {
              const user = db.getUser(query.slice(1));
              if (!user) {
                ui.showFailure("No such user");
                continue;
              }
              const theirs = db
                .listTicketsByOwner(user.address)
                .filter((t) => t.event_id === ev.event_id);
              if (theirs.length === 0) {
                ui.showFailure(`${query.slice(1)} holds no ticket for this event -> entry denied`);
                continue;
              }
              const picked = await ui.askTicket(
                `${query.slice(1)}'s tickets:`,
                theirs.map((row) => ({
                  row,
                  label: `Ticket #${row.ticket_id} · ${row.status}`,
                })),
              );
              if (!picked) continue;
              ticketId = picked.ticket_id;
            } else {
              ticketId = Number(query);
              if (!Number.isInteger(ticketId)) {
                ui.showFailure("Enter a ticket ID or @username");
                continue;
              }
            }

            // Fast lookup in the indexed view - no chain round-trip yet.
            const ticket = db.getTicket(ev.event_id, ticketId);
            if (!ticket) {
              ui.showFailure(`Ticket #${ticketId} does not belong to this event -> entry denied`);
              continue;
            }
            const holder = usernameOf(db, ticket.owner) ?? ticket.owner;
            if (ticket.status !== "Valid") {
              ui.showFailure(`Ticket #${ticketId} · holder ${holder} · ${ticket.status} ✘ -> entry denied`);
              continue;
            }
            ui.showSuccess(`Ticket #${ticketId} · holder ${holder} · VALID ✔`);

            // The code the holder shows is itself the verification - the contract only accepts a match.
            const code = await ui.askText("Code shown by the attendee:");
            const tx = await markUsed(chain, contract, session.privateKey, BigInt(ticketId), code.toUpperCase());
            ui.showSuccess(`✔ Checked in and recorded on-chain, tx ${tx}`);
          } catch (error) {
            if (ui.isCancel(error)) continue;
            ui.showError(error);
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

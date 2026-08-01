/**
 * The public audit interface (FR4) - no login, anyone can trace an event.
 *
 * Enter an event id to see that event's audit page: its indexed state plus
 * the on-chain addresses (the event's own contract and the factory) that
 * are the source of truth behind this data - every history row also
 * carries its block number and transaction hash, so any line can be
 * independently re-checked against the chain with a node or explorer of
 * the auditor's choosing. Inside an event, enter a ticket id for that
 * ticket's full lifecycle, or `all` for the whole event history.
 */

import { loadConfig } from "./config";
import { connect } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase } from "./db";
import { usernameOf } from "./auth";
import * as ui from "./ui";

async function main() {
  const config = loadConfig();
  const chain = connect(config);
  const db = openDatabase(config.databasePath);
  const { factory, network } = requireFactory();

  ui.showStartup(
    "Audit (no login required)",
    `Verification root EventFactory ${factory} (${network})`,
  );

  for (;;) {
    const eventInput = await ui.askQuery("Enter event ID (empty to exit):");
    if (!eventInput) break;
    const ev = db.getEvent(Number(eventInput));
    if (!ev) {
      ui.showFailure("No such event");
      continue;
    }

    // The event's audit page: indexed state + on-chain addresses.
    const currentBlock = Number(await chain.publicClient.getBlockNumber());
    const organiser = usernameOf(db, ev.organiser) ?? ev.organiser;
    const validators = db.listValidators(ev.event_id);
    console.log(`\n[Event #${ev.event_id} · ${ev.name}]`);
    console.log(`  Event contract: ${ev.contract} (on-chain verification address)`);
    console.log(`  Factory contract: ${factory}`);
    console.log(
      `  Organiser: ${organiser} (${ev.organiser}) · ${ui.eventPhase(ev, currentBlock, config.blockSeconds)}`,
    );
    console.log(
      `  Entry block ${ev.entry_block} · end block ${ev.end_block} · current block ${currentBlock}`,
    );
    console.log(
      `  Released ${ev.released}/${ev.capacity} · sold ${ev.sold} · price ${ui.eth(ev.price_wei)} · resale cap ${ui.eth(ev.resale_cap_wei)}`,
    );
    console.log(
      `  Validators: ${
        validators.length === 0
          ? "none"
          : validators
              .map((v) => `${usernameOf(db, v.address) ?? "?"} (${v.address})`)
              .join(", ")
      }\n`,
    );

    // Inside the event: per-ticket lifecycle, or the whole event history.
    // CTRL+C anywhere in here is caught right at this level, so it returns
    // to "Enter event ID" rather than exiting the whole program.
    try {
      for (;;) {
        const ticketInput = await ui.askQuery(
          "Ticket ID / all=full event history (empty to go back):",
        );
        if (!ticketInput) break;
        if (ticketInput === "all") {
          ui.showHistory(db.getEventHistory(ev.event_id));
          console.log();
          continue;
        }
        const ticketId = Number(ticketInput);
        const ticket = db.getTicket(ev.event_id, ticketId);
        if (!ticket) {
          ui.showFailure("No such ticket for this event");
          continue;
        }
        const nowBlock = Number(await chain.publicClient.getBlockNumber());
        ui.showTicketRow(
          ticket,
          ev.name,
          ui.ticketStatusLabel(ticket, db.getEvent(ev.event_id)!, nowBlock),
          usernameOf(db, ticket.owner),
        );
        ui.showHistory(db.getHistory(ev.event_id, ticketId));
        console.log();
      }
    } catch (error) {
      if (ui.isCancel(error)) continue; // CTRL+C mid-lookup: back to "Enter event ID"
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

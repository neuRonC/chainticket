/**
 * The public audit interface (FR4) - no login, anyone can trace an event.
 *
 * Enter an event id to see that event's audit page: 
 * its indexed state plus the on-chain addresses (the event's own contract and the factory) that
 * are the source of truth behind this data - 
 * every history row also carries its block number and transaction hash, 
 * so any line can be independently re-checked against the chain with a node or explorer of the auditor's choosing.
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

  ui.showInfo(`Verification root EventFactory ${factory} (${network})\n`);

  for (;;) {
    const eventInput = await ui.askText("Enter event ID:");
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

    // Ticket lookup, or `all` for the whole event history.
    try {
      for (;;) {
        const ticketInput = await ui.askText("Ticket ID:");
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

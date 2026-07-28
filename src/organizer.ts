/**
 * The organiser's program.
 *
 * Login first; the contracts enforce that only the organiser of an event
 * may manage it. Creating an event deploys a fresh EventTicket contract
 * through the factory with block-number timing (entry and end). Tickets go
 * on sale in batches (releaseTickets), each batch carrying the deposit
 * that funds gas reimbursements and refund shortfalls. The organiser is
 * automatically a validator, may authorise more until the event ends, and
 * can close early (opening refunds); normally-ended events are settled
 * automatically by the platform's keeper.
 */

import type { Address } from "viem";
import { loadConfig } from "./config";
import { connect } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase, type EventRow } from "./db";
import { login } from "./auth";
import {
  authorizeValidator,
  closeEvent,
  createEvent,
  holdsTicket,
  isValidatorOn,
  readDepositPerTicket,
  readFeeParams,
  releaseTickets,
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
  const balance = await chain.getBalance(session.address);
  ui.showSuccess(
    `Welcome ${session.username} (${session.address}) · balance ${ui.eth(balance)}\n`,
  );
  const fee = await readFeeParams(chain, factory); // pricing: chain is the source of truth

  // Minutes of human time -> an absolute block number.
  const toBlocks = (minutes: number, from: bigint) =>
    from + BigInt(Math.ceil((minutes * 60) / config.blockSeconds));

  // Pick from labelled events (empty list => info message).
  async function pick(message: string, events: EventRow[], block: number) {
    if (events.length === 0) {
      ui.showInfo("No matching events.");
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
    const currentBlock = Number(await chain.publicClient.getBlockNumber());
    const myEvents = db.listEventsByOrganiser(session.address);
    if (myEvents.length > 0) {
      ui.showInfo("[My events]");
      for (const ev of myEvents) ui.showEventRow(ev, currentBlock, config.blockSeconds);
      console.log();
    }

    const action = await ui.askAction("Action:", [
      { name: "Create event", value: "create" },
      { name: "Release tickets (batch sale)", value: "release" },
      { name: "Authorize validator", value: "validator" },
      { name: "Close event early", value: "close" },
      { name: "Exit", value: "exit" },
    ]);
    if (action === "exit") break;

    try {
      if (action === "create") {
        const name = await ui.askText("Event name:");
        const capacity = await ui.askPositiveInt("Total ticket supply:");
        // The contract rejects prices below the service fee; the field
        // re-prompts with the concrete minimum until the price covers it.
        const minPrice = (fee.feeFixedWei * 10000n) / (10000n - fee.feeBps) + 1n;
        const priceWei = await ui.askEth(
          "Price (ETH):",
          undefined,
          (wei) =>
            wei >= fee.feeFixedWei + (wei * fee.feeBps) / 10000n ||
            `Price must cover the service fee, minimum ~${ui.eth(minPrice)}`,
        );
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
        ui.showSuccess(
          `✔ Event #${eventId} "${name}" created (entry block ${entryBlock} · end block ${endBlock}), use "Release tickets" to start selling`,
        );
      } else if (action === "release") {
        const releasable = myEvents.filter(
          (ev) => !ev.closed && currentBlock < ev.entry_block && ev.released < ev.capacity,
        );
        const ev = await pick("Select event:", releasable, currentBlock);
        if (!ev) continue;
        const count = await ui.askPositiveInt(
          `How many tickets to release (remaining ${ev.capacity - ev.released}):`,
          "10",
        );
        const perTicket = await readDepositPerTicket(chain, ev.contract as Address);
        const deposit = perTicket * BigInt(count);
        const sure = await ui.askConfirm(
          `Release ${count} tickets, deposit ${ui.eth(deposit)} (refunded on settlement). Confirm?`,
        );
        if (!sure) continue;
        const balance = await chain.getBalance(session.address);
        if (balance < deposit) {
          ui.showFailure(`Insufficient balance: deposit needs ${ui.eth(deposit)}, current ${ui.eth(balance)}`);
          continue;
        }
        await releaseTickets(chain, ev.contract as Address, session.privateKey, BigInt(count));
        ui.showSuccess(`✔ Released ${count} tickets`);
      } else if (action === "validator") {
        const active = myEvents.filter((ev) => !ev.closed && currentBlock < ev.end_block);
        const ev = await pick("Select event:", active, currentBlock);
        if (!ev) continue;
        // Re-prompt until a valid candidate is given; empty input backs out.
        let user;
        for (;;) {
          const username = await ui.askQuery("Validator username (empty to go back):");
          if (!username) break;
          user = db.getUser(username);
          if (!user) {
            ui.showFailure(`No such user: ${username}`);
            continue;
          }
          if (await isValidatorOn(chain, ev.contract as Address, user.address as Address)) {
            ui.showFailure(`${username} is already a validator for this event`);
            user = undefined;
            continue;
          }
          if (await holdsTicket(chain, ev.contract as Address, user.address as Address)) {
            ui.showFailure(`${username} holds a ticket for this event and cannot be authorised as a validator`);
            user = undefined;
            continue;
          }
          break;
        }
        if (!user) continue;
        await authorizeValidator(
          chain,
          ev.contract as Address,
          session.privateKey,
          user.address as Address,
        );
        ui.showSuccess(`✔ Authorized ${user.username} as a validator for event #${ev.event_id}`);
      } else if (action === "close") {
        const closable = myEvents.filter((ev) => !ev.closed && currentBlock < ev.end_block);
        const ev = await pick("Select event to close:", closable, currentBlock);
        if (!ev) continue;
        const beforeEntry = currentBlock < ev.entry_block;
        const sure = await ui.askConfirm(
          beforeEntry
            ? `The event has not reached its scheduled end time. Closing early opens full refunds for everyone, and the deposit is forfeited. Confirm?`
            : `⚠ Close event #${ev.event_id}: revenue from checked-in tickets settles to you, unused tickets become refundable, deposit is forfeited. Confirm?`,
        );
        if (!sure) continue;
        await closeEvent(chain, ev.contract as Address, session.privateKey);
        ui.showSuccess(`✔ Event #${ev.event_id} closed, refunds are now open`);
      }
    } catch (error) {
      if (ui.isCancel(error)) continue; // CTRL+C inside a flow: back to menu
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

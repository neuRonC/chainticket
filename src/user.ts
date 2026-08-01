/**
 * The ticket user's program (buyer/holder).
 *
 * Login first. Buying starts from the event (pick one on sale, then all
 * offers - the official primary sale and other users' listings - sorted by
 * price ascending); sales and the resale market close when entry opens.
 * Tickets can be listed for resale under the contract-enforced cap, and
 * refunds claimed after an early closure. All prices are gas-inclusive.
 *
 * Each held ticket needs a check-in code before the gate will accept it -
 * a stand-in for a QR code. Only its hash goes on-chain (commit); the
 * plaintext is generated and kept here, and shown at the gate (reveal). A
 * resale clears the code, so the new owner generates their own.
 */

import { randomBytes } from "node:crypto";
import type { Address } from "viem";
import { loadConfig } from "./config";
import { connect } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase, type EventRow, type TicketRow } from "./db";
import { login, usernameOf } from "./auth";
import {
  buy,
  buyListed,
  claimRefund,
  hashCheckInCode,
  listForResale,
  setCheckInCode,
  unlist,
} from "./ticketing";
import * as ui from "./ui";

// Simulates a QR code: a short, random, human-typeable string.
function generateCheckInCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

async function main() {
  const config = loadConfig();
  const chain = connect(config);
  const db = openDatabase(config.databasePath);
  requireFactory(); // fail fast if the system is not deployed yet

  ui.showStartup("User");

  const credentials = await ui.askLogin();
  const session = login(db, credentials.username, credentials.password);
  if (!session) {
    ui.showFailure("Invalid account details");
    process.exit(1);
  }
  const eventOf = (t: TicketRow) => db.getEvent(t.event_id)!;

  for (;;) {
    const currentBlock = Number(await chain.publicClient.getBlockNumber());
    const balance = await chain.getBalance(session.address);
    ui.showIdentity(session.username, session.address, balance);
    console.log();
    const mine = db.listTicketsByOwner(session.address);

    const refundable = mine.filter(
      (t) => t.status === "Valid" && eventOf(t).refunds_open,
    );
    const action = await ui.askAction("Action:", [
      { name: "Buy ticket", value: "buy" },
      { name: "Manage ticket", value: "manage" },
      ...(refundable.length > 0
        ? [{ name: `Claim refund (${refundable.length} eligible)`, value: "refund" }]
        : []),
      { name: "Refresh", value: "refresh" },
      { name: "Exit", value: "exit" },
    ]);
    if (action === "exit") break;

    try {
      if (action === "buy") {
        // Step 1: pick the event. On sale = before entry, not closed, with
        // released stock or someone else's listing.
        const othersListings = (ev: EventRow) =>
          db
            .listTicketsOfEvent(ev.event_id)
            .filter(
              (t) =>
                t.listed_price_wei !== "0" &&
                t.owner.toLowerCase() !== session.address.toLowerCase(),
            );
        const hasPrimary = (ev: EventRow) => ev.sold < ev.released;
        const buyable = db
          .listEvents()
          .filter(
            (ev) =>
              !ev.closed &&
              currentBlock < ev.entry_block &&
              (hasPrimary(ev) || othersListings(ev).length > 0),
          );
        if (buyable.length === 0) {
          ui.showFailure("No tickets on sale right now.");
          continue;
        }
        const ev = await ui.askEvent(
          "Select event:",
          buyable.map((row) => ({
            row,
            label: `#${row.event_id} ${row.name} · ${ui.eventPhase(row, currentBlock, config.blockSeconds)} · price ${ui.eth(row.price_wei)}`,
          })),
        );
        if (!ev) continue;

        // Step 2: every offer for this event, price ascending.
        type Offer = { kind: "primary" } | { kind: "listing"; t: TicketRow };
        const offers: { name: string; value: Offer | null; price: bigint }[] =
          othersListings(ev).map((t) => ({
            name: `[Resale] ${ui.eth(t.listed_price_wei)} · ticket #${t.ticket_id} · seller ${usernameOf(db, t.owner) ?? t.owner}`,
            value: { kind: "listing", t },
            price: BigInt(t.listed_price_wei),
          }));
        if (hasPrimary(ev)) {
          offers.push({
            name: `[Official] ${ui.eth(ev.price_wei)} · remaining ${ev.released - ev.sold}`,
            value: { kind: "primary" },
            price: BigInt(ev.price_wei),
          });
        }
        offers.sort((x, y) => (x.price < y.price ? -1 : x.price > y.price ? 1 : 0));
        const pick = await ui.askAction("Select purchase:", [
          ...offers.map((o) => ({ name: o.name, value: o.value })),
          { name: "<- Back", value: null },
        ]);
        if (!pick) continue;

        const offerPrice = BigInt(
          pick.kind === "primary" ? ev.price_wei : pick.t.listed_price_wei,
        );
        const walletBalance = await chain.getBalance(session.address);
        if (walletBalance < offerPrice) {
          ui.showFailure(`Insufficient balance: need ${ui.eth(offerPrice)}, current ${ui.eth(walletBalance)}`);
          continue;
        }
        if (pick.kind === "primary") {
          if (!(await ui.askConfirm(`Pay ${ui.eth(offerPrice)} for a ticket to "${ev.name}"?`)))
            continue;
          const ticketId = await buy(
            chain,
            ev.contract as Address,
            session.privateKey,
            offerPrice,
          );
          ui.showSuccess(`✔ Purchase successful, got ticket #${ticketId}`);
        } else {
          const t = pick.t;
          if (!(await ui.askConfirm(`Pay ${ui.eth(offerPrice)} for resale ticket #${t.ticket_id}?`)))
            continue;
          await buyListed(
            chain,
            ev.contract as Address,
            session.privateKey,
            BigInt(t.ticket_id),
            offerPrice,
          );
          ui.showSuccess(`✔ Purchased resale ticket #${t.ticket_id}, payment settled to the seller`);
        }
      } else if (action === "manage") {
        // Level A: repeatedly pick a ticket to manage. Only backing out
        // here (CTRL+C or "<- Back") returns to the main menu.
        for (;;) {
          const myTickets = db.listTicketsByOwner(session.address);
          if (myTickets.length === 0) {
            ui.showFailure("You have no tickets.");
            break;
          }
          const t = await ui.askTicket(
            "Select a ticket to manage:",
            myTickets.map((row) => {
              const ev = eventOf(row);
              const status = ui.ticketStatusLabel(row, ev, currentBlock);
              const listed = row.listed_price_wei !== "0" ? ` · listed ${ui.eth(row.listed_price_wei)}` : "";
              return { row, label: `Ticket #${row.ticket_id} · ${ev.name} · ${status}${listed}` };
            }),
          );
          if (!t) break;

          // Level B: the action menu for this one ticket. A CTRL+C at its
          // own prompt is caught here, landing back on "Select a ticket to
          // manage:" instead of the main menu.
          try {
            for (;;) {
              const freshT = db.getTicket(t.event_id, t.ticket_id)!;
              const ev = eventOf(freshT);
              const currentBlock = Number(await chain.publicClient.getBlockNumber());
              ui.showTicketRow(freshT, ev.name, ui.ticketStatusLabel(freshT, ev, currentBlock));
              if (freshT.status === "Valid" && freshT.checkin_code) {
                ui.showInfo(`    check-in code: ${freshT.checkin_code}`);
              }
              console.log();

              const sub = await ui.askAction("Manage ticket:", [
                { name: "Generate check-in code", value: "code" },
                { name: "Resale ticket", value: "resale" },
                { name: "<- Back", value: "back" },
              ]);
              if (sub === "back") break;

              // Level C: this action's own detail entry. A CTRL+C here is
              // caught right below, landing back on "Manage ticket:".
              try {
                if (sub === "code") {
                  if (freshT.status !== "Valid") {
                    ui.showFailure("This ticket is not valid.");
                    continue;
                  }
                  if (freshT.checkin_code) {
                    ui.showInfo(`This ticket's check-in code is already: ${freshT.checkin_code}`);
                    continue;
                  }
                  const code = generateCheckInCode();
                  await setCheckInCode(
                    chain,
                    ev.contract as Address,
                    session.privateKey,
                    BigInt(freshT.ticket_id),
                    hashCheckInCode(code),
                  );
                  db.setCheckInCode(ev.event_id, freshT.ticket_id, code);
                  ui.showSuccess(`✔ Check-in code for ticket #${freshT.ticket_id}: ${code} (show this at the gate)`);
                } else if (sub === "resale") {
                  if (freshT.listed_price_wei !== "0") {
                    ui.showInfo(`This ticket is already listed at ${ui.eth(freshT.listed_price_wei)}.`);
                    const sure = await ui.askConfirm("Unlist it now?");
                    if (!sure) continue;
                    await unlist(chain, ev.contract as Address, session.privateKey, BigInt(freshT.ticket_id));
                    ui.showSuccess(`✔ Ticket #${freshT.ticket_id} unlisted`);
                  } else {
                    if (freshT.status !== "Valid" || ev.closed || currentBlock >= ev.entry_block) {
                      ui.showFailure("This ticket cannot be listed right now.");
                      continue;
                    }
                    const capWei = BigInt(ev.resale_cap_wei);
                    const asking = await ui.askEth(
                      `Asking price (ETH, cap ${ui.eth(ev.resale_cap_wei)}):`,
                      ui.eth(ev.resale_cap_wei).replace(" ETH", ""),
                      (wei) => wei <= capWei || `Price exceeds the resale cap (${ui.eth(ev.resale_cap_wei)})`,
                    );
                    await listForResale(chain, ev.contract as Address, session.privateKey, BigInt(freshT.ticket_id), asking);
                    ui.showSuccess(`✔ Ticket #${freshT.ticket_id} listed at ${ui.eth(asking)}`);
                  }
                }
              } catch (error) {
                if (ui.isCancel(error)) continue; // CTRL+C mid-entry: back to "Manage ticket:"
                ui.showError(error);
              }
            }
          } catch (error) {
            if (ui.isCancel(error)) continue; // CTRL+C at "Manage ticket:": back to "Select a ticket to manage:"
            ui.showError(error);
          }
        }
      } else if (action === "refund") {
        const t = await ui.askTicket(
          "Select ticket to refund:",
          refundable.map((row) => ({
            row,
            label: `Ticket #${row.ticket_id} · ${eventOf(row).name} · refundable ${ui.eth(eventOf(row).price_wei)}`,
          })),
        );
        if (!t) continue;
        const ev = eventOf(t);
        await claimRefund(chain, ev.contract as Address, session.privateKey, BigInt(t.ticket_id));
        const after = await chain.getBalance(session.address);
        ui.showSuccess(`✔ Refund complete, balance ${ui.eth(after)}`);
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

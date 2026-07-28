/**
 * The ticket user's program (buyer/holder).
 *
 * Login first. Buying starts from the event (pick one on sale, then all
 * offers - the official primary sale and other users' listings - sorted by
 * price ascending); sales and the resale market close when entry opens.
 * Tickets can be listed for resale under the contract-enforced cap, and
 * refunds claimed after an early closure. All prices are gas-inclusive.
 */

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
  listForResale,
  unlist,
} from "./ticketing";
import * as ui from "./ui";

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
  const balance = await chain.getBalance(session.address);
  ui.showSuccess(
    `Welcome ${session.username} (${session.address}) · balance ${ui.eth(balance)}\n`,
  );

  const eventOf = (t: TicketRow) => db.getEvent(t.event_id)!;

  for (;;) {
    const currentBlock = Number(await chain.publicClient.getBlockNumber());
    const mine = db.listTicketsByOwner(session.address);
    if (mine.length > 0) {
      ui.showInfo("[My tickets]");
      for (const t of mine) {
        const ev = eventOf(t);
        ui.showTicketRow(t, ev.name, ui.ticketStatusLabel(t, ev, currentBlock));
      }
      console.log();
    }

    const refundable = mine.filter(
      (t) => t.status === "Valid" && eventOf(t).refunds_open,
    );
    const action = await ui.askAction("Action:", [
      { name: "Buy", value: "buy" },
      { name: "List for resale / unlist", value: "resell" },
      ...(refundable.length > 0
        ? [{ name: `Claim refund (${refundable.length} eligible)`, value: "refund" }]
        : []),
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
          ui.showInfo("No tickets on sale right now.");
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
      } else if (action === "resell") {
        const resellable = mine.filter((t) => {
          const ev = eventOf(t);
          return (
            t.status === "Valid" && !ev.closed && currentBlock < ev.entry_block
          );
        });
        if (resellable.length === 0) {
          ui.showInfo("No tickets available to list.");
          continue;
        }
        const t = await ui.askTicket(
          "Select ticket:",
          resellable.map((row) => ({
            row,
            label: `Ticket #${row.ticket_id} · ${eventOf(row).name}${row.listed_price_wei !== "0" ? ` · listed ${ui.eth(row.listed_price_wei)}` : ""}`,
          })),
        );
        if (!t) continue;
        const ev = eventOf(t);
        const contract = ev.contract as Address;
        if (t.listed_price_wei !== "0") {
          if (await ui.askConfirm(`Ticket #${t.ticket_id} is listed, unlist it now?`)) {
            await unlist(chain, contract, session.privateKey, BigInt(t.ticket_id));
            ui.showSuccess(`✔ Ticket #${t.ticket_id} unlisted`);
          }
        } else {
          const asking = await ui.askEth(
            `Asking price (ETH, cap ${ui.eth(ev.resale_cap_wei)}):`,
            ui.eth(ev.resale_cap_wei).replace(" ETH", ""),
          );
          await listForResale(chain, contract, session.privateKey, BigInt(t.ticket_id), asking);
          ui.showSuccess(`✔ Ticket #${t.ticket_id} listed at ${ui.eth(asking)}`);
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

/**
 * The indexer / event listener / keeper - the platform's off-chain computational component.
 *
 * Three jobs in one always-running process:
 * 1. Watch the EventFactory and every event contract over WebSocket and keep the shared database in sync.
 * 2. Print every chain event live - the demo's window into the chain.
 * 3. Act as the keeper: contracts cannot auto-execute, so when a block arrives that passes an event's endBlock, the indexer sends the
 *    permissionless settle() transaction with the platform's key, paying its own gas like any other caller.
 */

import { formatEther, type Address, type Hex } from "viem";
import { loadConfig } from "./config";
import { connect, type Chain } from "./chain";
import { requireFactory } from "./deployment";
import { openDatabase, type Db } from "./db";
import {
  getPastFactoryEvents,
  getPastTicketEvents,
  onFactoryEvent,
  onTicketEvent,
  settle,
  sweepLeftovers,
  type DecodedLog,
} from "./ticketing";
import * as ui from "./ui";

const watched = new Set<string>();
const settling = new Set<number>(); // events with a settle tx in flight

async function main() {
  const config = loadConfig();
  const chain = connect(config);
  const db = openDatabase(config.databasePath);
  const { factory } = requireFactory();

  ui.showStartup("Indexer", `EventFactory ${factory}`);

  // The keeper signs settle() as the platform.
  const platformKey = db.getUser("platform")?.private_key as Hex | undefined;

  onFactoryEvent(chain, factory, (log) => {
    applyFactoryEvent(db, log);
    watchTicketContracts(chain, db);
  });
  const factoryPast = await getPastFactoryEvents(chain, factory);
  for (const log of factoryPast) applyFactoryEvent(db, log);
  await watchTicketContracts(chain, db);
  ui.showInfo("Backfill complete. Waiting for new events...\n");

  chain.publicClient.watchBlockNumber({
    onBlockNumber: async (blockNumber) => {
      if (!platformKey) return;
      for (const ev of db.listEvents()) {
        if (settling.has(ev.event_id)) continue;
        const contract = ev.contract as Address;
        try {
          if (!ev.closed && blockNumber >= BigInt(ev.end_block)) {
            settling.add(ev.event_id);
            ui.showInfo(`⏱ Event #${ev.event_id} reached its end block, auto-settling...`);
            await settle(chain, contract, platformKey);
          } else if (
            ev.refunds_open &&
            blockNumber >= BigInt(ev.end_block + config.sweepDelayBlocks) &&
            (await chain.getBalance(contract)) > 0n
          ) {
            settling.add(ev.event_id);
            ui.showInfo(`⏱ Event #${ev.event_id} sweep delay elapsed, collecting unclaimed leftovers...`);
            await sweepLeftovers(chain, contract, platformKey);
          }
        } catch (error) {
          settling.delete(ev.event_id); // retry on the next block
          console.error(`keeper #${ev.event_id} failed:`, ui.causeOf(error));
        }
      }
    },
  });
}

// Subscribe to any registry contract not watched yet.
async function watchTicketContracts(chain: Chain, db: Db) {
  for (const ev of db.listEvents()) {
    if (watched.has(ev.contract)) continue;
    watched.add(ev.contract);
    const contract = ev.contract as Address;
    onTicketEvent(chain, contract, (log) => applyTicketEvent(db, ev.event_id, log));
    const past = await getPastTicketEvents(chain, contract);
    for (const log of past) applyTicketEvent(db, ev.event_id, log);
  }
}

// Apply one factory event: register the new event contract.
export function applyFactoryEvent(db: Db, log: DecodedLog) {
  if (log.eventName !== "EventCreated") return;
  let fresh = true;
  const a = log.args as {
    eventId: bigint;
    eventContract: Address;
    organiser: Address;
    name: string;
    capacity: bigint;
    price: bigint;
    resaleCap: bigint;
    entryBlock: bigint;
    endBlock: bigint;
  };
  db.upsertEvent({
    event_id: Number(a.eventId),
    contract: a.eventContract,
    organiser: a.organiser,
    name: a.name,
    capacity: Number(a.capacity),
    price_wei: a.price.toString(),
    resale_cap_wei: a.resaleCap.toString(),
    entry_block: Number(a.entryBlock),
    end_block: Number(a.endBlock),
  });
  fresh = db.appendHistory({
    event_id: Number(a.eventId),
    ticket_id: null,
    block_number: Number(log.blockNumber),
    tx_hash: log.transactionHash,
    kind: "EventCreated",
    detail: `"${a.name}" contract ${a.eventContract} · capacity ${a.capacity} · price ${formatEther(a.price)} ETH · entry block ${a.entryBlock} · end block ${a.endBlock}`,
  });
  if (!fresh) return;
  ui.showInfo(`⛓ EventCreated  #${a.eventId} "${a.name}" → ${a.eventContract}`);
}

// Apply one EventTicket event to the database.
export function applyTicketEvent(db: Db, eventId: number, log: DecodedLog) {
  const base = {
    event_id: eventId,
    block_number: Number(log.blockNumber),
    tx_hash: log.transactionHash,
    kind: log.eventName,
  };
  const a = log.args as Record<string, unknown>;
  const ticketId = a.ticketId !== undefined ? Number(a.ticketId) : null;
  let fresh = true;

  switch (log.eventName) {
    case "TicketsReleased": {
      db.setReleased(eventId, Number(a.totalReleased));
      fresh = db.appendHistory({
        ...base,
        ticket_id: null,
        detail: `Released ${a.count} tickets (total ${a.totalReleased})`,
      });
      break;
    }
    case "ValidatorAuthorized":
    case "ValidatorRevoked": {
      const validator = a.validator as string;
      db.setValidator(eventId, validator, log.eventName === "ValidatorAuthorized");
      fresh = db.appendHistory({ ...base, ticket_id: null, detail: `Validator ${validator}` });
      break;
    }
    case "TicketPurchased": {
      db.insertTicket(eventId, ticketId!, a.buyer as string);
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: `Purchased · buyer ${a.buyer} · ${formatEther(a.price as bigint)} ETH`,
      });
      break;
    }
    case "TicketListed": {
      db.setListingPrice(eventId, ticketId!, (a.price as bigint).toString());
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: `Listed · ${formatEther(a.price as bigint)} ETH`,
      });
      break;
    }
    case "TicketUnlisted": {
      db.setListingPrice(eventId, ticketId!, "0");
      fresh = db.appendHistory({ ...base, ticket_id: ticketId, detail: "Unlisted" });
      break;
    }
    case "ListingSold": {
      db.setTicketOwner(eventId, ticketId!, a.buyer as string);
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: `Resale sold · ${a.seller} → ${a.buyer} · ${formatEther(a.price as bigint)} ETH`,
      });
      break;
    }
    case "TicketUsed": {
      db.setTicketStatus(eventId, ticketId!, "Used");
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: `Checked in · validator ${a.validator}`,
      });
      break;
    }
    case "CheckInCodeSet": {
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: "Check-in code set",
      });
      break;
    }
    case "EventClosed": {
      db.setClosed(eventId, true);
      fresh = db.appendHistory({
        ...base,
        ticket_id: null,
        detail: `Closed early · organiser settled ${formatEther(a.payout as bigint)} ETH immediately · refunds open`,
      });
      break;
    }
    case "EventSettled": {
      db.setClosed(eventId, false);
      fresh = db.appendHistory({
        ...base,
        ticket_id: null,
        detail: `Settled · organiser received ${formatEther(a.payout as bigint)} ETH`,
      });
      break;
    }
    case "RefundClaimed": {
      db.setTicketStatus(eventId, ticketId!, "Refunded");
      fresh = db.appendHistory({
        ...base,
        ticket_id: ticketId,
        detail: `Refunded · ${a.holder} claimed ${formatEther(a.amount as bigint)} ETH`,
      });
      break;
    }
    case "LeftoverSwept": {
      fresh = db.appendHistory({
        ...base,
        ticket_id: null,
        detail: `Platform swept · ${formatEther(a.amount as bigint)} ETH`,
      });
      break;
    }
    default:
      return; // unknown event: ignore
  }
  if (!fresh) return;
  ui.showInfo(
    `⛓ ${log.eventName.padEnd(18)} event#${eventId}${ticketId ? ` ticket#${ticketId}` : ""}`,
  );
}

// Only run as a script, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

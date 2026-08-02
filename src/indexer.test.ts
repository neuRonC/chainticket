/**
 * Unit tests for the indexer's pure event-application functions - no chain, no network. 
 * A DecodedLog is built by hand and applied straight to a fresh in-memory database.
 */

import { describe, expect, test } from "vitest";
import { openDatabase } from "./db";
import { applyFactoryEvent, applyTicketEvent } from "./indexer";
import type { DecodedLog } from "./ticketing";

function fakeLog(eventName: string, args: Record<string, unknown>): DecodedLog {
  return {
    eventName,
    args,
    blockNumber: 1n,
    transactionHash: "0xhash",
    address: "0xcontract",
  } as DecodedLog;
}

const eventCreated = fakeLog("EventCreated", {
  eventId: 1n,
  eventContract: "0xEvt",
  organiser: "0xOrg",
  name: "Show",
  capacity: 10n,
  price: 100n,
  resaleCap: 100n,
  entryBlock: 10n,
  endBlock: 20n,
});

test("applyFactoryEvent registers a new event and ignores a replay", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);
  applyFactoryEvent(db, eventCreated); // same tx: backfill/live overlap

  expect(db.getEvent(1)?.name).toBe("Show");
  expect(db.getEventHistory(1)).toHaveLength(1);
});

test("applyTicketEvent tracks a primary purchase then a resale transfer", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);

  applyTicketEvent(db, 1, fakeLog("TicketPurchased", { ticketId: 1n, buyer: "0xAlice", price: 100n }));
  expect(db.getTicket(1, 1)?.owner).toBe("0xAlice");
  expect(db.getEvent(1)?.sold).toBe(1);

  applyTicketEvent(db, 1, fakeLog("ListingSold", { ticketId: 1n, seller: "0xAlice", buyer: "0xBob", price: 90n }));
  const t = db.getTicket(1, 1);
  expect(t?.owner).toBe("0xBob");
  expect(t?.listed_price_wei).toBe("0"); // any stale listing is cleared on transfer
});

test("applyTicketEvent marks a ticket used", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);
  applyTicketEvent(db, 1, fakeLog("TicketPurchased", { ticketId: 1n, buyer: "0xAlice", price: 100n }));

  applyTicketEvent(db, 1, fakeLog("TicketUsed", { ticketId: 1n, validator: "0xVal" }));

  expect(db.getTicket(1, 1)?.status).toBe("Used");
});

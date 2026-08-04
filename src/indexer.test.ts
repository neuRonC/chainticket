/**
 * Unit tests for the indexer.
 */

import { describe, expect, test, vi } from "vitest";
import { openDatabase } from "./db";
import { applyFactoryEvent, applyTicketEvent } from "./indexer";
import type { DecodedLog } from "./ticketing";

// applyFactoryEvent/applyTicketEvent log to stdout for the live indexer CLI - silence that here.
vi.spyOn(console, "log").mockImplementation(() => {});

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

test("applyTicketEvent covers release, listing, validators, code, and closure", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);

  applyTicketEvent(db, 1, fakeLog("TicketsReleased", { count: 5n, totalReleased: 5n }));
  expect(db.getEvent(1)?.released).toBe(5);

  applyTicketEvent(db, 1, fakeLog("ValidatorAuthorized", { validator: "0xVal" }));
  expect(db.listValidators(1).map((v) => v.address)).toEqual(["0xVal"]);

  applyTicketEvent(db, 1, fakeLog("ValidatorRevoked", { validator: "0xVal" }));
  expect(db.listValidators(1)).toHaveLength(0);

  applyTicketEvent(db, 1, fakeLog("TicketPurchased", { ticketId: 1n, buyer: "0xAlice", price: 100n }));
  applyTicketEvent(db, 1, fakeLog("TicketListed", { ticketId: 1n, price: 90n }));
  expect(db.getTicket(1, 1)?.listed_price_wei).toBe("90");

  applyTicketEvent(db, 1, fakeLog("TicketUnlisted", { ticketId: 1n }));
  expect(db.getTicket(1, 1)?.listed_price_wei).toBe("0");

  applyTicketEvent(db, 1, fakeLog("CheckInCodeSet", { ticketId: 1n }));
  expect(db.getHistory(1, 1).some((h) => h.kind === "CheckInCodeSet")).toBe(true);

  applyTicketEvent(db, 1, fakeLog("EventClosed", { payout: 0n }));
  expect(db.getEvent(1)?.closed).toBe(1);
  expect(db.getEvent(1)?.refunds_open).toBe(1);

  applyTicketEvent(db, 1, fakeLog("RefundClaimed", { ticketId: 1n, holder: "0xAlice", amount: 100n }));
  expect(db.getTicket(1, 1)?.status).toBe("Refunded");

  applyTicketEvent(db, 1, fakeLog("LeftoverSwept", { amount: 1n }));
  expect(db.getEventHistory(1).some((h) => h.kind === "LeftoverSwept")).toBe(true);
});

test("applyTicketEvent EventSettled closes without opening refunds", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);

  applyTicketEvent(db, 1, fakeLog("EventSettled", { payout: 500n }));

  expect(db.getEvent(1)?.closed).toBe(1);
  expect(db.getEvent(1)?.refunds_open).toBe(0);
});

test("applyTicketEvent ignores an unknown event kind", () => {
  const db = openDatabase(":memory:");
  applyFactoryEvent(db, eventCreated);

  expect(() => applyTicketEvent(db, 1, fakeLog("SomethingElse", {}))).not.toThrow();
  expect(db.getEventHistory(1)).toHaveLength(1); // only EventCreated recorded
});

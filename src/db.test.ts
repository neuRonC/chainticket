/**
 * Unit tests for the SQLite schema and its query helpers - no chain, no network. 
 * Each test opens a fresh in-memory database.
 */

import { describe, expect, test } from "vitest";
import { openDatabase } from "./db";

function freshDb() {
  return openDatabase(":memory:");
}

const baseEvent = {
  event_id: 1,
  contract: "0xContract",
  organiser: "0xOrg",
  name: "Show",
  capacity: 10,
  price_wei: "100",
  resale_cap_wei: "100",
  entry_block: 10,
  end_block: 20,
};

describe("events", () => {
  test("upsertEvent ignores a replayed insert for the same id", () => {
    const db = freshDb();
    db.upsertEvent(baseEvent);
    db.upsertEvent({ ...baseEvent, name: "Different", capacity: 999 });
    const ev = db.getEvent(1);
    expect(ev?.name).toBe("Show");
    expect(ev?.capacity).toBe(10);
  });
});

describe("tickets", () => {
  test("insertTicket is idempotent and only counts sold once", () => {
    const db = freshDb();
    db.upsertEvent(baseEvent);
    db.insertTicket(1, 1, "0xBuyer");
    db.insertTicket(1, 1, "0xBuyer"); // a replayed indexer event
    expect(db.getEvent(1)?.sold).toBe(1);
  });

  test("setTicketOwner clears the listing price and check-in code", () => {
    const db = freshDb();
    db.upsertEvent(baseEvent);
    db.insertTicket(1, 1, "0xSeller");
    db.setListingPrice(1, 1, "50");
    db.setCheckInCode(1, 1, "ABCD1234");

    db.setTicketOwner(1, 1, "0xBuyer");

    const t = db.getTicket(1, 1);
    expect(t?.owner).toBe("0xBuyer");
    expect(t?.listed_price_wei).toBe("0");
    expect(t?.checkin_code).toBe("");
  });

  test("setTicketStatus clears a stale listing once a ticket is no longer Valid", () => {
    const db = freshDb();
    db.upsertEvent(baseEvent);
    db.insertTicket(1, 1, "0xOwner");
    db.setListingPrice(1, 1, "50");

    db.setTicketStatus(1, 1, "Used");

    expect(db.getTicket(1, 1)?.listed_price_wei).toBe("0");
  });
});

describe("history", () => {
  test("appendHistory dedupes a replayed event (backfill/live overlap)", () => {
    const db = freshDb();
    const row = {
      event_id: 1,
      ticket_id: null,
      block_number: 5,
      tx_hash: "0xHash",
      kind: "TicketsReleased",
      detail: "x",
    };
    expect(db.appendHistory(row)).toBe(true);
    expect(db.appendHistory(row)).toBe(false);
    expect(db.getEventHistory(1)).toHaveLength(1);
  });
});

describe("validators", () => {
  test("listValidators only returns currently active ones", () => {
    const db = freshDb();
    db.setValidator(1, "0xA", true);
    db.setValidator(1, "0xB", true);
    db.setValidator(1, "0xB", false); // revoked

    expect(db.listValidators(1).map((v) => v.address)).toEqual(["0xA"]);
  });
});

describe("users", () => {
  test("getUserByAddress looks up case-insensitively", () => {
    const db = freshDb();
    db.upsertUser({
      username: "alice",
      salt: "s",
      pass_hash: "h",
      private_key: "0xkey",
      address: "0xABCDEF",
    });

    expect(db.getUserByAddress("0xabcdef")?.username).toBe("alice");
  });
});

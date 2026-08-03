/**
 * Unit tests for ui.ts.
 */

import { describe, expect, test } from "vitest";
import { causeOf, eth, eventPhase, isCancel, ticketStatusLabel } from "./ui";
import type { EventRow, TicketRow } from "./db";

const baseEvent: EventRow = {
  event_id: 1,
  contract: "0xC",
  organiser: "0xO",
  name: "Show",
  capacity: 10,
  price_wei: "1000000000000000000",
  resale_cap_wei: "1000000000000000000",
  entry_block: 100,
  end_block: 200,
  released: 5,
  sold: 1,
  closed: 0,
  refunds_open: 0,
};

const baseTicket: TicketRow = {
  event_id: 1,
  ticket_id: 1,
  owner: "0xOwner",
  status: "Valid",
  listed_price_wei: "0",
  checkin_code: "",
};

test("eth formats wei as an ETH string", () => {
  expect(eth("1000000000000000000")).toBe("1 ETH");
  expect(eth(500000000000000000n)).toBe("0.5 ETH");
});

describe("eventPhase", () => {
  test("before entry: on sale", () => {
    expect(eventPhase(baseEvent, 50, 1)).toMatch(/^On sale/);
  });

  test("between entry and end: in progress", () => {
    expect(eventPhase(baseEvent, 150, 1)).toBe("In progress - check-in open");
  });

  test("past end, not closed: ended", () => {
    expect(eventPhase(baseEvent, 250, 1)).toBe("Ended - awaiting settlement");
  });

  test("closed without refunds: settled", () => {
    expect(eventPhase({ ...baseEvent, closed: 1 }, 250, 1)).toBe("Settled");
  });

  test("closed with refunds open", () => {
    expect(eventPhase({ ...baseEvent, closed: 1, refunds_open: 1 }, 150, 1)).toBe("Closed - refunds open");
  });
});

describe("ticketStatusLabel", () => {
  test("Used and Refunded pass through regardless of event state", () => {
    expect(ticketStatusLabel({ ...baseTicket, status: "Used" }, baseEvent, 50)).toBe("Used");
    expect(ticketStatusLabel({ ...baseTicket, status: "Refunded" }, baseEvent, 50)).toBe("Refunded");
  });

  test("Valid ticket is Refundable once the event's refunds are open", () => {
    expect(ticketStatusLabel(baseTicket, { ...baseEvent, refunds_open: 1 }, 50)).toBe("Refundable");
  });

  test("Valid ticket is Expired once the event has ended", () => {
    expect(ticketStatusLabel(baseTicket, baseEvent, 250)).toBe("Expired");
  });

  test("otherwise Valid", () => {
    expect(ticketStatusLabel(baseTicket, baseEvent, 50)).toBe("Valid");
  });
});

test("isCancel recognises an inquirer ExitPromptError", () => {
  const err = new Error("cancelled");
  err.name = "ExitPromptError";
  expect(isCancel(err)).toBe(true);
  expect(isCancel(new Error("other"))).toBe(false);
  expect(isCancel("not an error")).toBe(false);
});

describe("causeOf", () => {
  test("returns a plain Error's message", () => {
    expect(causeOf(new Error("boom"))).toBe("boom");
  });

  test("stringifies a non-Error value", () => {
    expect(causeOf("oops")).toBe("oops");
  });
});

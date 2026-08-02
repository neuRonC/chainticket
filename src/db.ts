/**
 * The shared off-chain database (SQLite).
 *
 * Holds three groups of data: 
 * the local user store (username/password -> address mapping - the chain never sees usernames), 
 * the indexed views the indexer derives from contract events (events, tickets, validators),
 * the append-only history behind the audit interface. 
 * Every history row carries its block number and transaction hash, 
 * and the audit interface shows each event's contract address, 
 * so anything here can be re-checked against the chain --- 
 * the database is a convenience cache, the chain is the source of truth. 
 * The one exception is a ticket's check-in code: 
 * the user program writes its plaintext here directly (only the hash ever reaches the chain), 
 * so it cannot be recovered from contract events.
 *
 * The database file lives under tmp/ as a generated artefact.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface UserRow {
  username: string;
  salt: string;
  pass_hash: string;
  private_key: string;
  address: string;
}

export interface EventRow {
  event_id: number;
  contract: string;
  organiser: string;
  name: string;
  capacity: number;
  price_wei: string;
  resale_cap_wei: string;
  entry_block: number; // gates open: sales stop, check-in starts
  end_block: number; // event over: settlement possible
  released: number; // tickets released for sale so far
  sold: number;
  closed: number; // 1 = settled or closed early
  refunds_open: number; // 1 = closed early, refunds claimable
}

export interface TicketRow {
  event_id: number;
  ticket_id: number;
  owner: string;
  status: "Valid" | "Used" | "Refunded";
  listed_price_wei: string; // "0" = not listed
  checkin_code: string; // "" = none set; plaintext, kept off-chain (only its hash is on-chain)
}

export interface ValidatorRow {
  event_id: number;
  address: string;
  active: number;
}

export interface HistoryRow {
  id: number;
  event_id: number;
  ticket_id: number | null;
  block_number: number;
  tx_hash: string;
  kind: string;
  detail: string;
  recorded_at: string;
}

export function openDatabase(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username    TEXT PRIMARY KEY,
      salt        TEXT NOT NULL,
      pass_hash   TEXT NOT NULL,
      private_key TEXT NOT NULL,
      address     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id       INTEGER PRIMARY KEY,
      contract       TEXT NOT NULL,
      organiser      TEXT NOT NULL,
      name           TEXT NOT NULL,
      capacity       INTEGER NOT NULL,
      price_wei      TEXT NOT NULL,
      resale_cap_wei TEXT NOT NULL,
      entry_block    INTEGER NOT NULL,
      end_block      INTEGER NOT NULL,
      released       INTEGER NOT NULL DEFAULT 0,
      sold           INTEGER NOT NULL DEFAULT 0,
      closed         INTEGER NOT NULL DEFAULT 0,
      refunds_open   INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tickets (
      event_id         INTEGER NOT NULL,
      ticket_id        INTEGER NOT NULL,
      owner            TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'Valid',
      listed_price_wei TEXT NOT NULL DEFAULT '0',
      checkin_code     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (event_id, ticket_id)
    );
    CREATE TABLE IF NOT EXISTS validators (
      event_id INTEGER NOT NULL,
      address  TEXT NOT NULL,
      active   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (event_id, address)
    );
    CREATE TABLE IF NOT EXISTS history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id     INTEGER NOT NULL,
      ticket_id    INTEGER,
      block_number INTEGER NOT NULL,
      tx_hash      TEXT NOT NULL,
      kind         TEXT NOT NULL,
      detail       TEXT NOT NULL,
      recorded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- One history row per (transaction, kind, ticket): lets the indexer's
    -- backfill overlap its live subscription without double-recording.
    CREATE UNIQUE INDEX IF NOT EXISTS history_dedupe
      ON history (tx_hash, kind, event_id, ifnull(ticket_id, 0));
  `);

  return {
    // The local user store.

    upsertUser(row: UserRow) {
      db.prepare(
        `INSERT OR REPLACE INTO users (username, salt, pass_hash, private_key, address)
         VALUES (@username, @salt, @pass_hash, @private_key, @address)`,
      ).run(row);
    },

    getUser(username: string): UserRow | undefined {
      return db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as
        | UserRow
        | undefined;
    },

    getUserByAddress(address: string): UserRow | undefined {
      return db
        .prepare(`SELECT * FROM users WHERE lower(address) = lower(?)`)
        .get(address) as UserRow | undefined;
    },

    // Written by the indexer, from contract events.

    upsertEvent(
      row: Omit<EventRow, "released" | "sold" | "closed" | "refunds_open">,
    ) {
      db.prepare(
        `INSERT OR IGNORE INTO events
           (event_id, contract, organiser, name, capacity, price_wei, resale_cap_wei,
            entry_block, end_block)
         VALUES (@event_id, @contract, @organiser, @name, @capacity, @price_wei,
                 @resale_cap_wei, @entry_block, @end_block)`,
      ).run(row);
    },

    setReleased(eventId: number, released: number) {
      db.prepare(`UPDATE events SET released = ? WHERE event_id = ?`).run(
        released,
        eventId,
      );
    },

    setClosed(eventId: number, refundsOpen: boolean) {
      db.prepare(
        `UPDATE events SET closed = 1, refunds_open = ? WHERE event_id = ?`,
      ).run(refundsOpen ? 1 : 0, eventId);
    },

    insertTicket(eventId: number, ticketId: number, owner: string) {
      // OR IGNORE + conditional count keeps a replayed purchase idempotent.
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO tickets (event_id, ticket_id, owner) VALUES (?, ?, ?)`,
        )
        .run(eventId, ticketId, owner);
      if (result.changes > 0) {
        db.prepare(`UPDATE events SET sold = sold + 1 WHERE event_id = ?`).run(eventId);
      }
    },

    setTicketOwner(eventId: number, ticketId: number, owner: string) {
      db.prepare(
        `UPDATE tickets SET owner = ?, listed_price_wei = '0', checkin_code = ''
         WHERE event_id = ? AND ticket_id = ?`,
      ).run(owner, eventId, ticketId);
    },

    setTicketStatus(eventId: number, ticketId: number, status: TicketRow["status"]) {
      db.prepare(
        `UPDATE tickets SET status = ?, listed_price_wei =
           CASE WHEN ? = 'Valid' THEN listed_price_wei ELSE '0' END
         WHERE event_id = ? AND ticket_id = ?`,
      ).run(status, status, eventId, ticketId);
    },

    setListingPrice(eventId: number, ticketId: number, priceWei: string) {
      db.prepare(
        `UPDATE tickets SET listed_price_wei = ? WHERE event_id = ? AND ticket_id = ?`,
      ).run(priceWei, eventId, ticketId);
    },

    // Written directly by the user program - never derived from the chain.
    setCheckInCode(eventId: number, ticketId: number, code: string) {
      db.prepare(
        `UPDATE tickets SET checkin_code = ? WHERE event_id = ? AND ticket_id = ?`,
      ).run(code, eventId, ticketId);
    },

    setValidator(eventId: number, address: string, active: boolean) {
      db.prepare(
        `INSERT OR REPLACE INTO validators (event_id, address, active) VALUES (?, ?, ?)`,
      ).run(eventId, address, active ? 1 : 0);
    },

    // Returns false when the row was already recorded (backfill overlap).
    appendHistory(row: Omit<HistoryRow, "id" | "recorded_at">): boolean {
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO history (event_id, ticket_id, block_number, tx_hash, kind, detail)
           VALUES (@event_id, @ticket_id, @block_number, @tx_hash, @kind, @detail)`,
        )
        .run(row);
      return result.changes > 0;
    },

    // Read by the role programs and the audit interface.

    getEvent(eventId: number): EventRow | undefined {
      return db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(eventId) as
        | EventRow
        | undefined;
    },

    listEvents(): EventRow[] {
      return db.prepare(`SELECT * FROM events ORDER BY event_id`).all() as EventRow[];
    },

    listEventsByOrganiser(address: string): EventRow[] {
      return db
        .prepare(`SELECT * FROM events WHERE lower(organiser) = lower(?) ORDER BY event_id`)
        .all(address) as EventRow[];
    },

    getTicket(eventId: number, ticketId: number): TicketRow | undefined {
      return db
        .prepare(`SELECT * FROM tickets WHERE event_id = ? AND ticket_id = ?`)
        .get(eventId, ticketId) as TicketRow | undefined;
    },

    listTicketsByOwner(address: string): TicketRow[] {
      return db
        .prepare(
          `SELECT * FROM tickets WHERE lower(owner) = lower(?) ORDER BY event_id, ticket_id`,
        )
        .all(address) as TicketRow[];
    },

    listTicketsOfEvent(eventId: number): TicketRow[] {
      return db
        .prepare(`SELECT * FROM tickets WHERE event_id = ? ORDER BY ticket_id`)
        .all(eventId) as TicketRow[];
    },

    listValidators(eventId: number): ValidatorRow[] {
      return db
        .prepare(`SELECT * FROM validators WHERE event_id = ? AND active = 1`)
        .all(eventId) as ValidatorRow[];
    },

    getHistory(eventId: number, ticketId: number): HistoryRow[] {
      return db
        .prepare(
          `SELECT * FROM history WHERE event_id = ? AND ticket_id = ?
           ORDER BY block_number, id`,
        )
        .all(eventId, ticketId) as HistoryRow[];
    },

    getEventHistory(eventId: number): HistoryRow[] {
      return db
        .prepare(`SELECT * FROM history WHERE event_id = ? ORDER BY block_number, id`)
        .all(eventId) as HistoryRow[];
    },

    close() {
      db.close();
    },
  };
}

export type Db = ReturnType<typeof openDatabase>;

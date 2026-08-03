/**
 * Unit tests for login/session logic.
 */

import { describe, expect, test } from "vitest";
import type { Hex } from "viem";
import { openDatabase } from "./db";
import { login, provisionUsers, usernameOf } from "./auth";
import type { Config } from "./config";

const TEST_KEY = ("0x" + "11".repeat(32)) as Hex;

function configWith(username: string, password: string): Config {
  return {
    networkName: "anvil",
    providerUrl: "ws://localhost:8545",
    chainId: 31337,
    blockSeconds: 1,
    sweepDelayBlocks: 1,
    databasePath: ":memory:",
    accounts: { [username]: { privateKey: TEST_KEY, password } },
  };
}

describe("login", () => {
  test("succeeds with the right password and returns the signing key", () => {
    const db = openDatabase(":memory:");
    provisionUsers(db, configWith("alice", "correct-horse"));

    const session = login(db, "alice", "correct-horse");

    expect(session?.username).toBe("alice");
    expect(session?.privateKey).toBe(TEST_KEY);
  });

  test("fails on a wrong password", () => {
    const db = openDatabase(":memory:");
    provisionUsers(db, configWith("alice", "correct-horse"));

    expect(login(db, "alice", "wrong")).toBeUndefined();
  });

  test("fails for an unknown username", () => {
    const db = openDatabase(":memory:");
    expect(login(db, "nobody", "x")).toBeUndefined();
  });
});

describe("usernameOf", () => {
  test("finds the username behind an address", () => {
    const db = openDatabase(":memory:");
    provisionUsers(db, configWith("alice", "pw"));
    const session = login(db, "alice", "pw")!;

    expect(usernameOf(db, session.address)).toBe("alice");
  });

  test("returns undefined for an unknown address", () => {
    const db = openDatabase(":memory:");
    expect(usernameOf(db, "0xdead")).toBeUndefined();
  });
});

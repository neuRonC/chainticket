/**
 * The local identity layer: username/password login backed by the user store in the shared database.
 *
 * Usernames exist only off-chain - the chain sees nothing but addresses.
 * Passwords are stored salted and hashed (scrypt); 
 * a successful login hands the program the account's private key so it can sign transactions as that user. 
 * Login failures are reported with one uniform message so an attacker cannot probe which usernames exist.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import type { Config } from "./config";
import type { Db } from "./db";

export interface Session {
  username: string;
  privateKey: Hex;
  address: Address;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

/* Provision the demo users from config.yaml into the user store. 
Existing rows are overwritten so re-seeding resets passwords. */
export function provisionUsers(db: Db, config: Config) {
  for (const [username, account] of Object.entries(config.accounts)) {
    if (username === "platform") continue;
    const salt = randomBytes(16).toString("hex");
    db.upsertUser({
      username,
      salt,
      pass_hash: hashPassword(account.password, salt),
      private_key: account.privateKey,
      address: privateKeyToAccount(account.privateKey).address,
    });
  }
}

/* Provision the platform account into the user store. 
   Takes the actual deployer key rather than trusting config, 
   so the stored identity always matches who really deployed the factory. */
export function provisionPlatform(db: Db, config: Config, deployerKey: Hex) {
  const salt = randomBytes(16).toString("hex");
  db.upsertUser({
    username: "platform",
    salt,
    pass_hash: hashPassword(config.accounts.platform.password, salt),
    private_key: deployerKey,
    address: privateKeyToAccount(deployerKey).address,
  });
}

// Verify a username/password pair against the user store.
// Returns the session (with the signing key) on success, undefined on any failure.
export function login(
  db: Db,
  username: string,
  password: string,
): Session | undefined {
  const user = db.getUser(username);
  if (!user) return undefined;
  const expected = Buffer.from(user.pass_hash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  if (!timingSafeEqual(expected, actual)) return undefined;
  return {
    username,
    privateKey: user.private_key as Hex,
    address: user.address as Address,
  };
}

// The username behind an address, for display
export function usernameOf(db: Db, address: string): string | undefined {
  return db.getUserByAddress(address)?.username;
}

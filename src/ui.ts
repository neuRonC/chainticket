/**
 * The user interface: ask the questions, and print the results. 
 * Nothing here talks to the blockchain - it just collects input and shows output.
 */

import { select, input, confirm, password as passwordPrompt } from "@inquirer/prompts";
import {
  BaseError,
  ContractFunctionRevertedError,
  formatEther,
  parseEther,
} from "viem";
import type { EventRow, HistoryRow, TicketRow } from "./db";

export function eth(wei: bigint | string): string {
  return `${formatEther(BigInt(wei))} ETH`;
}

// Block timing helpers.

// A rough human duration for a number of blocks.
function blocksToTime(blocks: number, blockSeconds: number): string {
  const s = blocks * blockSeconds;
  if (s < 90) return `${s}s`;
  return `${Math.round(s / 60)}min`;
}

// The phase label of an event at the current block.
export function eventPhase(
  ev: EventRow,
  currentBlock: number,
  blockSeconds: number,
): string {
  if (ev.closed) return ev.refunds_open ? "Closed - refunds open" : "Settled";
  if (currentBlock < ev.entry_block) {
    return `On sale (entry in ~${blocksToTime(ev.entry_block - currentBlock, blockSeconds)})`;
  }
  if (currentBlock < ev.end_block) return "In progress - check-in open";
  return "Ended - awaiting settlement";
}

// The display status of one ticket, given its event and the current block.
export function ticketStatusLabel(
  t: TicketRow,
  ev: EventRow,
  currentBlock: number,
): string {
  if (t.status === "Refunded") return "Refunded";
  if (t.status === "Used") return "Used";
  if (ev.refunds_open) return "Refundable";
  if (ev.closed || currentBlock >= ev.end_block) return "Expired";
  return "Valid";
}

// Prompts.

// Print which program this is, plus optional user-relevant detail.
export function showStartup(role: string, detail?: string) {
  console.log(`---- ${role} ----`);
  if (detail) console.log(detail);
  console.log();
}

// Ask for the login credentials. The caller verifies them.
export async function askLogin() {
  const username = await input({ message: "Username:" });
  const password = await passwordPrompt({ message: "Password:", mask: "*" });
  return { username, password };
}

// Ask for a menu action; `choices` maps labels to values of any shape.
export function askAction<T>(
  message: string,
  choices: { name: string; value: T }[],
): Promise<T> {
  return select({ message, choices });
}

// Pick one event from a labelled list; null means the user backed out.
export function askEvent(
  message: string,
  events: { row: EventRow; label: string }[],
): Promise<EventRow | null> {
  return select<EventRow | null>({
    message,
    choices: [
      ...events.map((e) => ({ name: e.label, value: e.row as EventRow | null })),
      { name: "<- Back", value: null },
    ],
  });
}

// Pick one ticket from a list; null means the user backed out.
export function askTicket(
  message: string,
  tickets: { row: TicketRow; label: string }[],
): Promise<TicketRow | null> {
  return select<TicketRow | null>({
    message,
    choices: [
      ...tickets.map((t) => ({ name: t.label, value: t.row as TicketRow | null })),
      { name: "<- Back", value: null },
    ],
  });
}

// True when the user hit CTRL+C inside a prompt: treat it as "cancel and go back", not as an error.
export function isCancel(error: unknown): boolean {
  return error instanceof Error && error.name === "ExitPromptError";
}

// Ask for free-form text; empty input means "go back".
export async function askQuery(message: string): Promise<string | undefined> {
  const value = await input({ message });
  return value.trim() === "" ? undefined : value.trim();
}

// Ask for a positive whole number.
export async function askPositiveInt(
  message: string,
  defaultValue?: string,
): Promise<number> {
  const value = await input({
    message,
    default: defaultValue,
    validate: (v) => (/^\d+$/.test(v) && Number(v) > 0) || "Enter a positive integer",
  });
  return Number(value);
}

// Ask for a non-negative ETH amount. An optional semantic check runs at the field, so a bad value re-prompts instead of aborting the flow.
export async function askEth(
  message: string,
  defaultValue?: string,
  check?: (wei: bigint) => true | string,
): Promise<bigint> {
  const value = await input({
    message,
    default: defaultValue,
    validate: (v) => {
      if (!/^\d+(\.\d+)?$/.test(v)) return "Enter an ETH amount, e.g. 0.05";
      return check ? check(parseEther(v)) : true;
    },
  });
  return parseEther(value);
}

// Ask for a text field.
export function askText(message: string, defaultValue?: string): Promise<string> {
  return input({
    message,
    default: defaultValue,
    validate: (v) => v.trim().length > 0 || "Cannot be empty",
  });
}

// A yes/no confirmation.
export function askConfirm(message: string): Promise<boolean> {
  return confirm({ message, default: false });
}

// Output.

// Print one event's summary line.
export function showEventRow(ev: EventRow, currentBlock: number, blockSeconds: number) {
  console.log(
    `  #${ev.event_id} ${ev.name} · ${eventPhase(ev, currentBlock, blockSeconds)} · released ${ev.released}/${ev.capacity} · sold ${ev.sold} · price ${eth(ev.price_wei)}`,
  );
}

// Print one ticket's summary line.
export function showTicketRow(
  t: TicketRow,
  eventName: string,
  statusLabel: string,
  ownerName?: string,
) {
  const listed =
    t.listed_price_wei !== "0" ? ` · listed ${eth(t.listed_price_wei)}` : "";
  const owner = ownerName ? ` · holder ${ownerName}` : "";
  console.log(`  ticket #${t.ticket_id} · ${eventName} · ${statusLabel}${listed}${owner}`);
}

// Print a ticket's indexed history, one line per lifecycle step.
export function showHistory(rows: HistoryRow[]) {
  if (rows.length === 0) {
    showFailure("No history recorded.");
    return;
  }
  for (const row of rows) {
    console.log(
      `  block ${String(row.block_number).padStart(4)}  ${row.kind.padEnd(18)} ${row.detail}  tx ${row.tx_hash.slice(0, 14)}…`,
    );
  }
}

// Print a one-line progress message.
export function showInfo(message: string) {
  console.log(message);
}

// ANSI colours (no dependency) for the messages below.
const boldRed = (text: string) => `\x1b[1;31m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;
const grey = (text: string) => `\x1b[90m${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m${text}\x1b[0m`;
const cyan = (text: string) => `\x1b[36m${text}\x1b[0m`;

// Print a highlighted success line.
export function showSuccess(message: string) {
  console.log(green(message));
}

// Print a highlighted failure line.
export function showFailure(message: string) {
  console.log(red(message));
}

// The recurring "who's logged in" status line shown at the top of every menu pass, coloured apart from both progress and failure output.
export function showIdentity(username: string, address: string, balanceWei: bigint | string) {
  console.log(cyan(`👤 user: ${username} · wallet: ${address} · balance: ${eth(balanceWei)}`));
}

// True when a transaction failed because the wallet cannot cover it.
function isInsufficientFunds(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    /insufficient funds|exceeds the balance/i.test(error.message)
  );
}

// Show a transaction/contract error without crashing: a bold short message and the decoded revert reason. 
// Enough to debug, not a stack dump.
export function showError(error: unknown) {
  if (isInsufficientFunds(error)) {
    showFailure("Insufficient wallet balance to complete the transaction");
    return;
  }
  if (!(error instanceof BaseError)) {
    console.log(`\n${boldRed(String(error))}\n`);
    return;
  }
  // A decodable revert reason is the whole story - one clean line, no duplicated viem prose.
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError && revert.reason) {
    console.log(`\n${boldRed(`Transaction rejected by the contract: ${revert.reason}`)}\n`);
    return;
  }
  console.log(`\n${boldRed(error.shortMessage)}`);
  if (revert instanceof ContractFunctionRevertedError && revert.data) {
    console.log(grey(`${revert.data.errorName}(${(revert.data.args ?? []).join(", ")})`));
  }
  console.log();
}

// The one-line cause of a failure, for inline display.
export function causeOf(error: unknown): string {
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      if (revert.reason) return revert.reason;
      if (revert.data) {
        return `${revert.data.errorName}(${(revert.data.args ?? []).join(", ")})`;
      }
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

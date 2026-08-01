# ChainTicket

Blockchain PoC for auditable event-ticket lifecycle management: batch
primary sale → price-capped resale → gate validation → automatic
settlement, with early-closure refunds. Every event is its own on-chain
contract, block-timed; every step is an indexed on-chain event.

## Architecture

```
 Organizer CLI ──login──create/release/close──▶ ┌──────────────────────────────┐
 User CLI ──login──buy/list/refund────────────▶ │        EVM blockchain        │
 Validator CLI ──login──markUsed──────────────▶ │ EventFactory ──deploys──▶    │
                                                 │  EventTicket #1  #2  #3 ...  │
                                                 └──────────┬───────────────────┘
                              contract events + new blocks │  ▲ settle() by the keeper
                                               (WebSocket) ▼  │
 Audit CLI (no login) ──reads──▶ Off-chain database ◀── Indexer / keeper
                                 (SQLite: user store ·      (platform's daemon)
                                  indexed views · history)
```

### Contracts

- **`contracts/EventFactory.sol`** — deployed once by the platform.
  Registry (event id → contract), immutable sweep delay. `createEvent`
  deploys a fresh EventTicket.
- **`contracts/EventTicket.sol`** — one per event, ERC-721, block-timed
  (`entryBlock` / `endBlock`). No platform fee, no deposit: whoever sends
  a transaction pays its own gas.
  - `releaseTickets(n)` — batch sales, no deposit required.
  - Fairness (single `_update` checkpoint): resale-market-only transfers,
    one ticket per address, validators (incl. auto-authorised organiser)
    can't hold tickets. A resale also clears the ticket's check-in code.
  - Check-in codes (commit-reveal): `setCheckInCode` commits a hash of a
    QR-code stand-in; `markUsed` only accepts the matching plaintext.
  - `settle()` — permissionless after `endBlock`; the indexer keeper
    triggers it. `closeEvent()` — early closure, opens full refunds for
    unused tickets; `sweepLeftovers()` — platform collects unclaimed
    refunds after the delay.

### Off-chain programs (TypeScript + viem)

| Program | Login | Role |
|---|---|---|
| `src/organizer.ts` | yes | create/release/authorise validators/close |
| `src/user.ts` | yes | buy (primary + resale, price-sorted), list/unlist, refund |
| `src/validator.ts` | yes + on-chain check | check-in by id/@username, code-gated `markUsed` |
| `src/audit.ts` | no | per-event state + contract addresses + per-ticket history |
| `src/indexer.ts` | – | sync DB from events, live log, keeper (auto-settle/sweep) |

Identity (`src/auth.ts`): username/password (salted scrypt) → signing key;
chain only sees addresses.

### Trust boundary

Whether an event actually happened is an off-chain fact; zero check-ins
on a "held" event is the audit evidence. Disputes resolve off-chain.

## Setup

```sh
git init          # if needed
npm install
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
```

Generated artefacts live under `tmp/` (git-ignored).

## Testing

```sh
forge test        # 22 tests, vm.roll-driven block timing
```

## Demo

Identities (password `demo123`): `platform`, `org`, `user1`/`user2`/`user3`,
`val`. anvil runs 1-second blocks; fast-forward with:

```sh
cast rpc anvil_mine 0x100
```

### Staging

```sh
npm run node      # terminal 1: anvil --block-time 1
npm run seed      # terminal 2: full reset
npm run indexer   # terminal 3: leave running
```

### Story

1. **Organizer** `org` — create event, release a batch, authorise `val`.
2. **User** `user1` — buy, list for resale (try above cap). **User** `user2`
   — buy user1's listing, generate its check-in code.
3. **Validator** `val` — check user2 in before/after entry
   (`anvil_mine` to the window), entering the code user2 shows.
4. Fast-forward past `endBlock`: indexer auto-settles.
5. Second event: `user3` buys, `org` closes early, `user3` claims refund,
   fast-forward past the sweep delay.
6. **Audit** — event state + contract addresses; ticket history with
   block numbers and tx hashes.

## Sepolia deployment

Set `network: sepolia` in `config.yaml`, provide `SEPOLIA_RPC_URL` /
`SEPOLIA_PRIVATE_KEY` in the environment, run `npm run deploy` — it
deploys the factory and provisions the platform account, without touching
the demo user store that `npm run seed` also sets up.

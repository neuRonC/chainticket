# ChainTicket

Blockchain PoC for auditable event-ticket lifecycle management.

## Dependencies

TypeScript / Node — managed by `npm` via `package.json` and locked in `package-lock.json`

Solidity / Foundry — managed by `forge` via `foundry.toml` and locked in `foundry.lock`

see **Usage-Setup** for more instructions

## Usage

### Setup

```sh
npm install
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
```

### Run (demo)

Three long-running processes, each in its own terminal, in this order:

```sh
npm run node
npm run seed # or 'npm run deploy' to skip creating demo accounts
npm run indexer
```

Then, in any other terminal, act as a role:

```sh
npm run start # launch the role picker
```

Demo identities (password `demo123`): `org`, `user1`/`user2`/`user3`, `val`.

Fast-forward the chain:

```sh
npm run timetravel -- 5 # mines enough blocks to skip ~5 minutes
```

### Testing

```sh
npm run test
```

## Project Structure

### contract/

- `EventFactory.sol` — deploys a fresh `EventTicket` per event
- `EventTicket.sol` — one event's full lifecycle: sale, resale, check-in, settlement

### test/

- `Ticketing.t.sol` — Foundry tests for both contracts

### src/

Files in `src/` are split into two kinds:
**scripts** (have their own `main()`, run directly)
**modules** (only export functions, imported by others)

#### Scripts

##### Role-facing

- `user.ts`
- `organizer.ts`
- `validator.ts`
- `audit.ts`

#### Long-running service

- `indexer.ts`

#### Demo Setup

- `deploy.ts` — deploys `EventFactory`
- `seed.ts` — resets the database, calls `deploy.ts`, provisions demo users
- `launcher.ts` — a role-select menu that spawns a role scripts as a child processe
- `timetravel.ts` — mines blocks on the local anvil chain to skip time in the demo

#### Modules

##### Chain interaction

- `chain.ts` — viem client setup (public/wallet/test clients)
- `ticketing.ts` — wrappers for every contract read/write; the only place that touches the contract ABI

##### Domain state

- `db.ts` — the shared SQLite database (users, indexed events/tickets, audit history)
- `deployment.ts` — reads/writes `tmp/deployment.json` (the deployed factory address)

##### Identity & config

- `auth.ts` — username/password login, hands back the signing private key
- `config.ts` — loads `config.yaml`

##### Presentation

- `ui.ts` — shared CLI prompts/formatting used by every script

#### Tests

Each `*.test.ts` sits next to the module it tests

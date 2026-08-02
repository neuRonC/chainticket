# ChainTicket

Blockchain PoC for auditable event-ticket lifecycle management: batch
primary sale → price-capped resale → gate validation → automatic
settlement, with early-closure refunds. No platform fee, no deposit —
whoever sends a transaction pays its own gas. Linux only below.

## Setup

```sh
npm install
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build
```

## Run

Three long-running processes, each in its own terminal, in this order:

```sh
npm run node       # terminal 1: local chain (anvil, 1s blocks) - leave running
npm run seed       # terminal 2: full reset - deploys + creates demo accounts
npm run indexer    # terminal 3: keeper / event sync - leave running
```

Then, in any other terminal, act as a role:

```sh
npm run start        # role picker (spawns whichever of the below you choose)
npm run organizer     # login required
npm run user           # login required
npm run validator     # login required + on-chain check
npm run audit          # no login
```

Demo identities (password `demo123`): `platform`, `org`, `user1`/`user2`/`user3`, `val`.

Fast-forward the chain (anvil mines 1 block/second):

```sh
npm run timetravel -- 5   # mines enough blocks to skip ~5 minutes
```

## Testing

```sh
forge test
```

## Demo walkthrough

1. **Organizer** `org` — create event, release a batch, authorise `val`.
2. **User** `user1` — buy, list for resale. **User** `user2` — buy that
   listing, generate its check-in code.
3. **Validator** `val` — check user2 in (`timetravel` past entry first),
   entering the code user2 shows.
4. `timetravel` past `endBlock` — indexer auto-settles.
5. Second event: `user3` buys, `org` closes early, `user3` claims a
   refund, `timetravel` past the sweep delay.
6. **Audit** — look up the event and the ticket's history.

## Sepolia deployment

Set `network: sepolia` in `config.yaml`, provide `SEPOLIA_RPC_URL` /
`SEPOLIA_PRIVATE_KEY` in the environment, then:

```sh
npm run deploy   # deploys the factory + provisions the platform account
```

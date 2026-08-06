This plain-text file is provided to satisfy the submission requirement.
For richer formatting, please read README.md instead. :)


Dependencies

TypeScript / Node — managed by `npm` via `package.json` and locked in `package-lock.json`

Solidity / Foundry — managed by `forge` via `foundry.toml` and locked in `foundry.lock`

see 'Setup' for more instructions


Setup

npm install
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts
forge build


Run (demo)

Three long-running processes, each in its own terminal, in this order:

npm run node
npm run seed # or 'npm run deploy' to skip creating demo accounts
npm run indexer

Then, in any other terminal, act as a role:

npm run start # launch the role picker

Demo identities (password `demo123`): `org`, `user1`/`user2`/`user3`, `val`.

Fast-forward the chain:

npm run timetravel -- 5 # mines enough blocks to skip ~5 minutes


Testing

npm run test

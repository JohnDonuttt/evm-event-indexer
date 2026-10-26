# evm-event-indexer

Point it at any contract and its ABI, and it keeps a SQLite copy of that contract's events up to date and serves them over a small JSON API. It also handles chain reorganisations, which most quick scripts don't.

No code generation, no schema files, no GraphQL. One JSON config in, one HTTP endpoint out. It's meant for the cases where you want to query "all `Transfer` events to this address" or "latest 50 `Swap`s" without running a full indexing framework.

## Quick start

Needs Node 22.13+.

```sh
pnpm install
cp examples/erc20.config.json indexer.config.json   # edit address, startBlock, rpcUrl
pnpm start
```

```sh
curl 'localhost:3000/events?event=Transfer&arg.to=0xYourAddress&limit=10'
```

## Config

```json
{
  "rpcUrl": "http://127.0.0.1:8545",
  "contracts": [
    {
      "name": "USDC",
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "startBlock": 6082465,
      "abi": ["event Transfer(address indexed from, address indexed to, uint256 value)"],
      "events": ["Transfer"]
    }
  ]
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `rpcUrl` | required | Or set `RPC_URL`, which wins over the file |
| `contracts[].name` | required | Label used in the DB and API. Must be unique |
| `contracts[].address` | required | |
| `contracts[].abi` | required | Path to a JSON ABI or a Foundry/Hardhat artifact (read from its `abi` field), or an inline array of human-readable signatures or JSON ABI items |
| `contracts[].events` | all | Restrict to these event names |
| `contracts[].startBlock` | `0` | Set this to the deploy block, or the first sync will scan from genesis |
| `port` | `3000` | `PORT` env overrides |
| `pollMs` | `2000` | |
| `confirmations` | `0` | Hold back this many blocks from head. Reorgs are handled either way; this just avoids churn |
| `batchSize` | `2000` | Blocks per `eth_getLogs` call while catching up. Lower it if your RPC rejects large ranges |
| `checkpointsToKeep` | `128` | See reorg handling below |
| `dbPath` | `indexer.db` | Relative to the config file |

Multiple contracts go in the same `contracts` array and share one database and one cursor.

## API

| Route | Returns |
| --- | --- |
| `GET /health` | `{ ok, cursor }`: the last fully indexed block |
| `GET /contracts` | Configured contracts |
| `GET /stats` | Event counts per contract and event name |
| `GET /events` | Events, newest first |

`/events` query parameters:

| Param | Meaning |
| --- | --- |
| `contract`, `event` | Filter by name |
| `arg.<name>=<value>` | Exact match on a decoded argument, e.g. `arg.to=0xabc…`. Addresses match case-insensitively |
| `limit` | 1–500, default 50 |
| `before` | Return events from blocks strictly before this one. Pass `nextBefore` from the previous response to page |

Uint256 values are returned as decimal strings and addresses are lowercased.

## Reorg handling

Chains occasionally replace their most recent blocks. If you index a block that later gets orphaned, naive indexers keep its events forever.

How this one copes:

1. After each batch it saves **checkpoints**: the hash of the batch's last block, plus blocks 1, 2, 4, 8… behind it. These are dense near the tip and sparse further back.
2. At the start of every pass it checks the newest checkpoint's hash against the chain. Normally it matches and nothing else happens.
3. If it doesn't, it walks back to the newest checkpoint the chain still agrees with, deletes every event after it, and re-indexes forward. Rollback distance is at most about twice the real reorg depth.
4. If no stored checkpoint survives (a reorg deeper than `checkpointsToKeep` allows), it wipes the index and starts from `startBlock`.
5. If a reorg lands between fetching logs and reading the block hash, the batch is dropped and retried instead of committing events from a dead fork.

Writes (events, checkpoints, cursor) happen in a single SQLite transaction, so a crash never leaves the cursor ahead of the data.

## Testing

```sh
pnpm test
```

44 tests. The sync logic is tested against an in-memory fake chain that can be extended and reorganised, so the reorg paths are covered directly: a replaced fork, a shorter chain, an orphaned block with no replacement, partial checkpoint survival, a reorg deeper than stored checkpoints, and one landing mid-request. The rest cover the store, config validation, argument normalisation, and the API.

I also ran it against a live anvil node: indexed a deployed ERC-20, used `evm_snapshot` / `evm_revert` to orphan an already-indexed transfer and mine a different one at the same height, and confirmed the log showed the rollback and the API returned only the canonical event.

## Limitations

- Only contracts you list are indexed. No factory/dynamic contract discovery.
- Events only: no call traces, no state reads, no transaction-level data beyond the hash.
- One chain per process. Run one instance per chain.
- Polling, not websockets.
- `arg.` filters are exact match. There are no range queries on amounts, and no sorting other than by block.
- `node:sqlite` is experimental in Node 22 and prints a warning.
- The index lives in one SQLite file, which is fine for millions of events but is not meant for high write volume across many contracts.

## License

MIT

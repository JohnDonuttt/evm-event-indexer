import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Checkpoint, IndexedEvent } from "./types.js";

// vite (vitest) can't resolve the node:sqlite builtin yet, so load it via require
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    block_number INTEGER NOT NULL,
    log_index    INTEGER NOT NULL,
    tx_hash      TEXT NOT NULL,
    block_hash   TEXT NOT NULL,
    contract     TEXT NOT NULL,
    event        TEXT NOT NULL,
    args         TEXT NOT NULL,
    PRIMARY KEY (block_number, log_index)
  );
  CREATE INDEX IF NOT EXISTS events_name_idx ON events (contract, event, block_number);

  -- block hashes we've fully processed up to; used to detect and locate reorgs
  CREATE TABLE IF NOT EXISTS checkpoints (
    block_number INTEGER PRIMARY KEY,
    block_hash   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface EventQuery {
  contract?: string;
  event?: string;
  /** exact match on a decoded argument, e.g. { user: "0xabc…" } */
  args?: Record<string, string>;
  limit?: number;
  /** return events strictly before this block (for paging) */
  before?: bigint;
}

export interface StoredEvent {
  blockNumber: number;
  logIndex: number;
  txHash: string;
  blockHash: string;
  contract: string;
  event: string;
  args: Record<string, unknown>;
}

const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class Store {
  private db: DatabaseSyncType;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  cursor(): bigint | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get() as { value: string } | undefined;
    return row ? BigInt(row.value) : null;
  }

  /** Newest first. */
  checkpoints(limit = 64): Checkpoint[] {
    const rows = this.db
      .prepare("SELECT block_number, block_hash FROM checkpoints ORDER BY block_number DESC LIMIT ?")
      .all(limit) as { block_number: number; block_hash: string }[];
    return rows.map((r) => ({ blockNumber: BigInt(r.block_number), blockHash: r.block_hash }));
  }

  /**
   * Save a processed range in one transaction: its events, checkpoints, and the new cursor
   * (the highest checkpoint block). Either all of it lands or none of it does.
   */
  commit(events: IndexedEvent[], checkpoints: Checkpoint[], keepCheckpoints: number): void {
    const end = checkpoints.reduce((max, c) => (c.blockNumber > max ? c.blockNumber : max), checkpoints[0]!.blockNumber);
    const saveCheckpoint = this.db.prepare("INSERT OR REPLACE INTO checkpoints (block_number, block_hash) VALUES (?, ?)");

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO events (block_number, log_index, tx_hash, block_hash, contract, event, args)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        insert.run(Number(e.blockNumber), e.logIndex, e.txHash, e.blockHash, e.contract, e.event, JSON.stringify(e.args));
      }
      for (const c of checkpoints) saveCheckpoint.run(Number(c.blockNumber), c.blockHash);
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?)").run(end.toString());
      this.db
        .prepare(
          `DELETE FROM checkpoints WHERE block_number NOT IN
           (SELECT block_number FROM checkpoints ORDER BY block_number DESC LIMIT ?)`,
        )
        .run(keepCheckpoints);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Throw away everything after `blockNumber` (a reorg happened). null wipes the index. */
  rollbackTo(blockNumber: bigint | null): void {
    this.db.exec("BEGIN");
    try {
      if (blockNumber === null) {
        this.db.exec("DELETE FROM events; DELETE FROM checkpoints; DELETE FROM meta WHERE key = 'cursor';");
      } else {
        const n = Number(blockNumber);
        this.db.prepare("DELETE FROM events WHERE block_number > ?").run(n);
        this.db.prepare("DELETE FROM checkpoints WHERE block_number > ?").run(n);
        this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?)").run(n.toString());
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  query(q: EventQuery = {}): StoredEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (q.contract) {
      where.push("contract = ?");
      params.push(q.contract);
    }
    if (q.event) {
      where.push("event = ?");
      params.push(q.event);
    }
    if (q.before !== undefined) {
      where.push("block_number < ?");
      params.push(Number(q.before));
    }

    for (const [name, value] of Object.entries(q.args ?? {})) {
      // the name is interpolated into a JSON path, so it must be a plain identifier
      if (!ARG_NAME.test(name)) throw new Error(`invalid argument name "${name}"`);
      where.push(`json_extract(args, '$.${name}') = ?`);
      params.push(value.toLowerCase());
    }

    const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
    const sql = `SELECT block_number, log_index, tx_hash, block_hash, contract, event, args FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY block_number DESC, log_index DESC LIMIT ?`;

    const rows = this.db.prepare(sql).all(...params, limit) as {
      block_number: number;
      log_index: number;
      tx_hash: string;
      block_hash: string;
      contract: string;
      event: string;
      args: string;
    }[];

    return rows.map((r) => ({
      blockNumber: r.block_number,
      logIndex: r.log_index,
      txHash: r.tx_hash,
      blockHash: r.block_hash,
      contract: r.contract,
      event: r.event,
      args: JSON.parse(r.args) as Record<string, unknown>,
    }));
  }

  counts(): { contract: string; event: string; count: number }[] {
    return this.db
      .prepare("SELECT contract, event, COUNT(*) AS count FROM events GROUP BY contract, event ORDER BY contract, event")
      .all() as unknown as { contract: string; event: string; count: number }[];
  }

  close() {
    this.db.close();
  }
}

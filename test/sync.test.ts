import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.js";
import { checkpointBlocks, syncOnce, type SyncOptions } from "../src/sync.js";
import { FakeChain, ev } from "./fakeChain.js";

let chain: FakeChain;
let store: Store;

function opts(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return { chain, store, startBlock: 1n, confirmations: 0n, batchSize: 100n, checkpointsToKeep: 16, ...overrides };
}

const stored = () => store.query({ limit: 500 }).reverse();

beforeEach(() => {
  chain = new FakeChain();
  store = new Store();
});

describe("checkpointBlocks", () => {
  it("is just the end block for a one-block batch", () => {
    expect(checkpointBlocks(7n, 7n)).toEqual([7n]);
  });

  it("spaces checkpoints exponentially behind the end block", () => {
    expect(checkpointBlocks(0n, 20n)).toEqual([20n, 19n, 18n, 16n, 12n, 4n]);
  });

  it("never reaches before the start of the batch", () => {
    for (const block of checkpointBlocks(100n, 105n)) expect(block >= 100n).toBe(true);
  });
});

describe("syncOnce: normal indexing", () => {
  it("indexes events and advances the cursor", async () => {
    chain.mine([ev("Transfer", { n: 1 })], [], [ev("Transfer", { n: 2 }), ev("Approval", { n: 3 }, 1)]);

    const res = await syncOnce(opts());

    expect(res.events).toBe(3);
    expect(store.cursor()).toBe(3n);
    expect(stored().map((e) => e.args.n)).toEqual([1, 2, 3]);
  });

  it("only picks up new blocks on the next pass", async () => {
    chain.mine([ev("Transfer", { n: 1 })]);
    await syncOnce(opts());

    chain.mine([ev("Transfer", { n: 2 })]);
    const res = await syncOnce(opts());

    expect(res.events).toBe(1);
    expect(stored()).toHaveLength(2);
  });

  it("does nothing when already caught up", async () => {
    chain.mine([ev("Transfer")]);
    await syncOnce(opts());
    chain.eventCalls.length = 0;

    const res = await syncOnce(opts());

    expect(res.events).toBe(0);
    expect(chain.eventCalls).toHaveLength(0);
  });

  it("splits a long range into batches", async () => {
    for (let i = 0; i < 10; i++) chain.mine([ev("Transfer", { n: i })]);

    await syncOnce(opts({ batchSize: 4n }));

    expect(chain.eventCalls).toEqual([
      [1n, 4n],
      [5n, 8n],
      [9n, 10n],
    ]);
    expect(stored()).toHaveLength(10);
  });

  it("holds back the most recent blocks when confirmations are set", async () => {
    for (let i = 0; i < 6; i++) chain.mine([ev("Transfer", { n: i })]);

    await syncOnce(opts({ confirmations: 2n }));

    expect(store.cursor()).toBe(4n);
    expect(stored()).toHaveLength(4);
  });

  it("respects the configured start block", async () => {
    for (let i = 0; i < 5; i++) chain.mine([ev("Transfer", { n: i })]);

    await syncOnce(opts({ startBlock: 4n }));

    expect(stored().map((e) => e.args.n)).toEqual([3, 4]);
  });

  it("makes a single block-hash call per pass when nothing reorged", async () => {
    chain.mine([ev("Transfer")]);
    await syncOnce(opts());
    chain.hashCalls = 0;

    chain.mine([]);
    await syncOnce(opts());

    // 1 to verify the newest checkpoint + 1 for the new one-block batch
    expect(chain.hashCalls).toBe(2);
  });
});

describe("syncOnce: reorgs", () => {
  it("replaces events from an orphaned fork", async () => {
    chain.mine([ev("Transfer", { fork: "a", n: 1 })], [ev("Transfer", { fork: "a", n: 2 })], [ev("Transfer", { fork: "a", n: 3 })]);
    await syncOnce(opts());

    // blocks 2 and 3 are replaced by a different fork
    chain.reorg(1, [ev("Transfer", { fork: "b", n: 2 })], [], [ev("Transfer", { fork: "b", n: 4 })]);
    const res = await syncOnce(opts());

    expect(res.rolledBackTo).toBe(1n);
    expect(stored().map((e) => `${e.args.fork}${e.args.n}`)).toEqual(["a1", "b2", "b4"]);
    expect(store.cursor()).toBe(4n);
  });

  it("handles a chain that got shorter", async () => {
    chain.mine([ev("Transfer", { n: 1 })], [ev("Transfer", { n: 2 })], [ev("Transfer", { n: 3 })]);
    await syncOnce(opts());

    chain.reorg(1); // orphan blocks 2 and 3, nothing mined to replace them yet
    const res = await syncOnce(opts());

    expect(res.rolledBackTo).toBe(1n);
    expect(stored().map((e) => e.args.n)).toEqual([1]);
    expect(store.cursor()).toBe(1n);
  });

  it("removes events that no longer exist at all after the reorg", async () => {
    chain.mine([ev("Transfer", { n: 1 })], [ev("Transfer", { n: 2 })]);
    await syncOnce(opts());

    chain.reorg(1, []); // block 2 replaced by an empty block
    await syncOnce(opts());

    expect(stored().map((e) => e.args.n)).toEqual([1]);
  });

  it("finds the right ancestor when only some checkpoints were orphaned", async () => {
    for (let i = 0; i < 3; i++) {
      chain.mine([ev("Transfer", { fork: "a", n: chain.blocks.length })]);
      await syncOnce(opts()); // one checkpoint per block
    }

    chain.reorg(2, [ev("Transfer", { fork: "b", n: 3 })]); // only block 3 changes
    const res = await syncOnce(opts());

    expect(res.rolledBackTo).toBe(2n);
    expect(stored().map((e) => `${e.args.fork}${e.args.n}`)).toEqual(["a1", "a2", "b3"]);
  });

  it("re-indexes from scratch when the reorg is deeper than the stored checkpoints", async () => {
    chain.mine([ev("Transfer", { fork: "a", n: 1 })], [ev("Transfer", { fork: "a", n: 2 })]);
    await syncOnce(opts({ batchSize: 1n, checkpointsToKeep: 1 })); // keeps only the newest checkpoint

    chain.reorg(0, [ev("Transfer", { fork: "b", n: 1 })], [ev("Transfer", { fork: "b", n: 2 })]);
    const res = await syncOnce(opts({ checkpointsToKeep: 1 }));

    expect(res.rolledBackTo).toBeNull();
    expect(stored().map((e) => `${e.args.fork}${e.args.n}`)).toEqual(["b1", "b2"]);
  });

  it("drops a batch when a reorg lands between fetching logs and reading the block hash", async () => {
    chain.mine([ev("Transfer", { fork: "a", n: 1 })]);

    chain.afterGetEvents = () => chain.reorg(0, [ev("Transfer", { fork: "b", n: 1 })]);
    await syncOnce(opts());

    // nothing from the stale fork should have been committed
    expect(stored()).toHaveLength(0);
    expect(store.cursor()).toBeNull();

    // the next pass picks up the canonical chain
    await syncOnce(opts());
    expect(stored().map((e) => e.args.fork)).toEqual(["b"]);
  });
});

import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/store.js";
import type { IndexedEvent } from "../src/types.js";

function event(p: Partial<IndexedEvent> = {}): IndexedEvent {
  return {
    blockNumber: 1n,
    logIndex: 0,
    txHash: "0xtx",
    blockHash: "0xb1",
    contract: "Token",
    event: "Transfer",
    args: {},
    ...p,
  };
}

let store: Store;
beforeEach(() => {
  store = new Store();
});

describe("Store.commit", () => {
  it("saves events, a checkpoint and the cursor together", () => {
    store.commit([event()], [{ blockNumber: 5n, blockHash: "0xb5" }], 10);

    expect(store.cursor()).toBe(5n);
    expect(store.checkpoints()).toEqual([{ blockNumber: 5n, blockHash: "0xb5" }]);
    expect(store.query()).toHaveLength(1);
  });

  it("rolls back everything if a write fails", () => {
    const bad = { ...event({ logIndex: 1 }), args: { n: 1n } }; // JSON.stringify can't serialise bigint
    expect(() => store.commit([event(), bad], [{ blockNumber: 5n, blockHash: "0xb5" }], 10)).toThrow();

    expect(store.cursor()).toBeNull();
    expect(store.query()).toHaveLength(0);
    expect(store.checkpoints()).toHaveLength(0);
  });

  it("keeps only the newest N checkpoints", () => {
    for (let n = 1n; n <= 5n; n++) store.commit([], [{ blockNumber: n, blockHash: `0xb${n}` }], 3);
    expect(store.checkpoints().map((c) => c.blockNumber)).toEqual([5n, 4n, 3n]);
  });

  it("is idempotent for the same (block, log index)", () => {
    store.commit([event({ args: { v: "1" } })], [{ blockNumber: 1n, blockHash: "0xb1" }], 10);
    store.commit([event({ args: { v: "2" } })], [{ blockNumber: 1n, blockHash: "0xb1" }], 10);

    const rows = store.query();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.args.v).toBe("2");
  });
});

describe("Store.rollbackTo", () => {
  beforeEach(() => {
    for (let n = 1n; n <= 4n; n++) {
      store.commit([event({ blockNumber: n })], [{ blockNumber: n, blockHash: `0xb${n}` }], 10);
    }
  });

  it("removes later events and checkpoints and moves the cursor", () => {
    store.rollbackTo(2n);

    expect(store.query().map((e) => e.blockNumber).sort()).toEqual([1, 2]);
    expect(store.checkpoints().map((c) => c.blockNumber)).toEqual([2n, 1n]);
    expect(store.cursor()).toBe(2n);
  });

  it("null wipes the index", () => {
    store.rollbackTo(null);
    expect(store.cursor()).toBeNull();
    expect(store.query()).toHaveLength(0);
  });
});

describe("Store.query", () => {
  beforeEach(() => {
    store.commit(
      [
        event({ blockNumber: 1n, event: "Transfer", args: { to: "0xaa", amount: "5" } }),
        event({ blockNumber: 2n, event: "Approval", args: { to: "0xbb", amount: "9" } }),
        event({ blockNumber: 3n, event: "Transfer", args: { to: "0xbb", amount: "7" }, contract: "Other" }),
      ],
      [{ blockNumber: 3n, blockHash: "0xb3" }],
      10,
    );
  });

  it("returns newest first", () => {
    expect(store.query().map((e) => e.blockNumber)).toEqual([3, 2, 1]);
  });

  it("filters by contract, event and decoded args", () => {
    expect(store.query({ contract: "Other" })).toHaveLength(1);
    expect(store.query({ event: "Transfer" })).toHaveLength(2);
    expect(store.query({ args: { to: "0xbb" } })).toHaveLength(2);
    expect(store.query({ event: "Transfer", args: { to: "0xbb" } })).toHaveLength(1);
  });

  it("matches address args case-insensitively", () => {
    expect(store.query({ args: { to: "0xBB" } })).toHaveLength(2);
  });

  it("pages with before and limit", () => {
    expect(store.query({ limit: 1 }).map((e) => e.blockNumber)).toEqual([3]);
    expect(store.query({ before: 3n, limit: 1 }).map((e) => e.blockNumber)).toEqual([2]);
  });

  it("rejects argument names that could escape the JSON path", () => {
    expect(() => store.query({ args: { "to') OR 1=1 --": "x" } })).toThrow(/invalid argument name/);
  });

  it("counts by contract and event", () => {
    expect(store.counts()).toEqual([
      { contract: "Other", event: "Transfer", count: 1 },
      { contract: "Token", event: "Approval", count: 1 },
      { contract: "Token", event: "Transfer", count: 1 },
    ]);
  });
});

import type { ChainSource, IndexedEvent } from "../src/types.js";

interface FakeBlock {
  hash: string;
  events: { logIndex: number; event: string; args: Record<string, unknown> }[];
}

/** An in-memory chain that can be extended and reorganised. Block 0 is genesis (no events). */
export class FakeChain implements ChainSource {
  blocks: FakeBlock[] = [{ hash: "0xgenesis", events: [] }];
  private forks = 0;

  hashCalls = 0;
  eventCalls: [bigint, bigint][] = [];
  /** runs once, right after getEvents returns, to simulate a reorg landing mid-request */
  afterGetEvents?: () => void;

  mine(...events: FakeBlock["events"][]) {
    // each argument is the event list of one new block
    for (const list of events.length ? events : [[]]) {
      this.blocks.push({ hash: `0xb${this.blocks.length}f${this.forks}`, events: list });
    }
  }

  /** Drop everything after `height`, then mine replacement blocks on the new fork. */
  reorg(height: number, ...replacement: FakeBlock["events"][]) {
    this.blocks.length = height + 1;
    this.forks++;
    // no replacement means the chain just gets shorter
    if (replacement.length) this.mine(...replacement);
  }

  async getBlockNumber() {
    return BigInt(this.blocks.length - 1);
  }

  async getBlockHash(n: bigint) {
    this.hashCalls++;
    return this.blocks[Number(n)]?.hash ?? null;
  }

  async getEvents(from: bigint, to: bigint): Promise<IndexedEvent[]> {
    this.eventCalls.push([from, to]);
    const out: IndexedEvent[] = [];

    for (let n = Number(from); n <= Number(to); n++) {
      const block = this.blocks[n];
      if (!block) continue;
      for (const e of block.events) {
        out.push({
          blockNumber: BigInt(n),
          logIndex: e.logIndex,
          txHash: `0xtx${n}-${e.logIndex}`,
          blockHash: block.hash,
          contract: "Token",
          event: e.event,
          args: e.args,
        });
      }
    }

    const hook = this.afterGetEvents;
    this.afterGetEvents = undefined;
    hook?.();
    return out;
  }
}

export const ev = (event: string, args: Record<string, unknown> = {}, logIndex = 0) => ({ logIndex, event, args });

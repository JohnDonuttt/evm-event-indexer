import type { ChainSource, Checkpoint } from "./types.js";
import type { Store } from "./store.js";

export interface SyncOptions {
  chain: ChainSource;
  store: Store;
  startBlock: bigint;
  confirmations: bigint;
  batchSize: bigint;
  checkpointsToKeep: number;
  log?: (msg: string) => void;
}

export interface SyncResult {
  /** blocks thrown away because the chain reorganised */
  rolledBackTo: bigint | null | undefined;
  indexedTo: bigint | null;
  events: number;
}

/**
 * If the chain no longer contains the block hashes we recorded, find the newest one it
 * still agrees with and discard everything after it. Returns what we rolled back to, or
 * undefined if nothing was wrong.
 */
async function handleReorg(opts: SyncOptions): Promise<bigint | null | undefined> {
  const checkpoints = opts.store.checkpoints(opts.checkpointsToKeep);
  if (checkpoints.length === 0) return undefined;

  let ancestor: Checkpoint | undefined;
  for (const cp of checkpoints) {
    // missing block counts as a mismatch: the chain got shorter
    if ((await opts.chain.getBlockHash(cp.blockNumber)) === cp.blockHash) {
      ancestor = cp;
      break;
    }
  }

  // newest checkpoint still matches: no reorg (the common case, one RPC call)
  if (ancestor && ancestor.blockNumber === checkpoints[0]!.blockNumber) return undefined;

  if (ancestor) {
    opts.log?.(`reorg detected, rolling back to block ${ancestor.blockNumber}`);
    opts.store.rollbackTo(ancestor.blockNumber);
    return ancestor.blockNumber;
  }

  // reorg deeper than we kept checkpoints for: start over from the configured start block
  opts.log?.("reorg deeper than stored checkpoints, re-indexing from scratch");
  opts.store.rollbackTo(null);
  return null;
}

/**
 * Which blocks of a just-indexed batch to remember: the end, then 1, 2, 4, 8… blocks behind it.
 * Dense near the tip (where reorgs happen) and sparse further back, so after a reorg of depth d
 * we find a surviving ancestor within roughly 2d blocks instead of re-indexing everything.
 */
export function checkpointBlocks(from: bigint, to: bigint): bigint[] {
  const blocks = [to];
  for (let offset = 1n; to - offset >= from; offset *= 2n) blocks.push(to - offset);
  return blocks;
}

/** One pass: repair after any reorg, then index up to (head - confirmations). */
export async function syncOnce(opts: SyncOptions): Promise<SyncResult> {
  const rolledBackTo = await handleReorg(opts);

  const head = await opts.chain.getBlockNumber();
  const target = head - opts.confirmations;
  const cursor = opts.store.cursor();
  let from = cursor === null ? opts.startBlock : cursor + 1n;
  let total = 0;

  while (from <= target) {
    const to = from + opts.batchSize - 1n < target ? from + opts.batchSize - 1n : target;

    const events = await opts.chain.getEvents(from, to);
    const hashes = await Promise.all(checkpointBlocks(from, to).map((n) => opts.chain.getBlockHash(n)));
    const endHash = hashes[0];
    if (endHash === null || endHash === undefined) break; // block vanished between the calls; retry on the next pass

    // if the logs we got for the last block came from a different fork than the hash we
    // just read, a reorg landed mid-request. Drop the batch and let the next pass sort it out.
    const mismatch = events.some((e) => e.blockNumber === to && e.blockHash !== endHash);
    if (mismatch) break;

    const blocks = checkpointBlocks(from, to);
    const checkpoints = blocks.flatMap((blockNumber, i) => {
      const blockHash = hashes[i];
      return blockHash ? [{ blockNumber, blockHash }] : [];
    });

    opts.store.commit(events, checkpoints, opts.checkpointsToKeep);
    total += events.length;
    from = to + 1n;
  }

  return { rolledBackTo, indexedTo: opts.store.cursor(), events: total };
}

export async function runLoop(opts: SyncOptions & { pollMs: number; signal: AbortSignal }): Promise<void> {
  while (!opts.signal.aborted) {
    try {
      const res = await syncOnce(opts);
      if (res.events > 0) opts.log?.(`indexed ${res.events} events up to block ${res.indexedTo}`);
    } catch (err) {
      opts.log?.(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollMs));
  }
}

import type { Abi, Address } from "viem";

export interface ContractConfig {
  name: string;
  address: Address;
  abi: Abi;
  /** Event names to index. Empty means every event in the ABI. */
  events: string[];
  startBlock: bigint;
}

export interface Config {
  rpcUrl: string;
  contracts: ContractConfig[];
  dbPath: string;
  port: number;
  pollMs: number;
  /** Only index blocks this many behind head. 0 is fine because reorgs are handled; higher just means fewer rollbacks. */
  confirmations: bigint;
  /** Max blocks per eth_getLogs request while catching up. */
  batchSize: bigint;
  /** How many checkpoints to keep for finding the common ancestor after a reorg. */
  checkpointsToKeep: number;
}

/** One decoded log. `args` holds JSON-safe values: bigints as decimal strings, addresses lowercased. */
export interface IndexedEvent {
  blockNumber: bigint;
  logIndex: number;
  txHash: string;
  blockHash: string;
  contract: string;
  event: string;
  args: Record<string, unknown>;
}

/** What the sync loop needs from a chain. The real one wraps viem; tests use an in-memory fake. */
export interface ChainSource {
  getBlockNumber(): Promise<bigint>;
  /** null if the block doesn't exist (yet, or any more after a reorg) */
  getBlockHash(number: bigint): Promise<string | null>;
  getEvents(from: bigint, to: bigint): Promise<IndexedEvent[]>;
}

export interface Checkpoint {
  blockNumber: bigint;
  blockHash: string;
}

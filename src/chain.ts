import { createPublicClient, http, type AbiEvent } from "viem";
import { normalizeArgs } from "./normalize.js";
import type { ChainSource, ContractConfig, IndexedEvent } from "./types.js";

function selectEvents(contract: ContractConfig): AbiEvent[] {
  const all = contract.abi.filter((item): item is AbiEvent => item.type === "event");
  const wanted = contract.events.length ? all.filter((e) => contract.events.includes(e.name)) : all;

  const missing = contract.events.filter((name) => !all.some((e) => e.name === name));
  if (missing.length) {
    throw new Error(`${contract.name}: ABI has no event(s) named ${missing.join(", ")}`);
  }
  return wanted;
}

export function createChainSource(rpcUrl: string, contracts: ContractConfig[]): ChainSource {
  const client = createPublicClient({ transport: http(rpcUrl) });
  const eventsByContract = contracts.map((c) => ({ contract: c, events: selectEvents(c) }));

  return {
    getBlockNumber: () => client.getBlockNumber(),

    async getBlockHash(number) {
      try {
        const block = await client.getBlock({ blockNumber: number });
        return block.hash;
      } catch {
        return null; // viem throws BlockNotFoundError when the block is gone
      }
    },

    async getEvents(from, to) {
      const perContract = await Promise.all(
        eventsByContract.map(async ({ contract, events }) => {
          if (events.length === 0 || to < contract.startBlock) return [];

          const logs = await client.getLogs({
            address: contract.address,
            events,
            fromBlock: from < contract.startBlock ? contract.startBlock : from,
            toBlock: to,
            strict: true,
          });

          return logs.map(
            (log): IndexedEvent => ({
              blockNumber: log.blockNumber,
              logIndex: log.logIndex,
              txHash: log.transactionHash,
              blockHash: log.blockHash,
              contract: contract.name,
              event: log.eventName as string,
              args: normalizeArgs(log.args),
            }),
          );
        }),
      );

      return perContract.flat().sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
    },
  };
}

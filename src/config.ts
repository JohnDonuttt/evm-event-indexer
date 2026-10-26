import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isAddress, parseAbi, type Abi } from "viem";
import type { Config, ContractConfig } from "./types.js";

type Raw = Record<string, unknown>;

function fail(message: string): never {
  throw new Error(`config: ${message}`);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") fail(`"${field}" must be a non-empty string`);
  return value;
}

function asInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail(`"${field}" must be a non-negative integer`);
  return value;
}

/**
 * ABI can be:
 *   - a path to a JSON file (a plain ABI array, or a Foundry/Hardhat artifact with an "abi" field)
 *   - an inline array of human-readable signatures: ["event Transfer(address indexed from, ...)"]
 *   - an inline JSON ABI array
 */
function loadAbi(value: unknown, baseDir: string, label: string): Abi {
  if (typeof value === "string") {
    const file = resolve(baseDir, value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      fail(`${label}: could not read ABI file ${file} (${err instanceof Error ? err.message : err})`);
    }
    const abi = Array.isArray(parsed) ? parsed : (parsed as Raw | null)?.abi;
    if (!Array.isArray(abi)) fail(`${label}: ${file} is not an ABI array or an artifact with an "abi" field`);
    return abi as Abi;
  }

  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return parseAbi(value as string[]) as Abi;
    return value as Abi;
  }

  return fail(`${label}: "abi" must be a file path or an array`);
}

/** `baseDir` is where relative ABI paths resolve from, normally the config file's folder. */
export function parseConfig(raw: unknown, baseDir: string, env: Record<string, string | undefined> = {}): Config {
  if (!raw || typeof raw !== "object") fail("expected a JSON object");
  const cfg = raw as Raw;

  const rpcUrl = env.RPC_URL || (typeof cfg.rpcUrl === "string" ? cfg.rpcUrl : "");
  if (!rpcUrl) fail('no RPC endpoint: set "rpcUrl" in the config or the RPC_URL environment variable');

  if (!Array.isArray(cfg.contracts) || cfg.contracts.length === 0) fail('"contracts" must be a non-empty array');

  const names = new Set<string>();
  const contracts = cfg.contracts.map((c: Raw, i: number): ContractConfig => {
    const label = `contracts[${i}]`;
    const name = asString(c.name, `${label}.name`);
    if (names.has(name)) fail(`duplicate contract name "${name}"`);
    names.add(name);

    const address = asString(c.address, `${label}.address`);
    if (!isAddress(address)) fail(`${label}.address is not a valid address: ${address}`);

    const events = c.events === undefined ? [] : c.events;
    if (!Array.isArray(events) || !events.every((e) => typeof e === "string")) {
      fail(`${label}.events must be an array of event names`);
    }

    return {
      name,
      address,
      abi: loadAbi(c.abi, baseDir, `${label} (${name})`),
      events: events as string[],
      startBlock: BigInt(asInt(c.startBlock, `${label}.startBlock`, 0)),
    };
  });

  return {
    rpcUrl,
    contracts,
    dbPath: typeof cfg.dbPath === "string" ? resolve(baseDir, cfg.dbPath) : resolve(baseDir, "indexer.db"),
    port: asInt(env.PORT ? Number(env.PORT) : cfg.port, "port", 3000),
    pollMs: asInt(cfg.pollMs, "pollMs", 2000),
    confirmations: BigInt(asInt(cfg.confirmations, "confirmations", 0)),
    batchSize: BigInt(Math.max(1, asInt(cfg.batchSize, "batchSize", 2000))),
    checkpointsToKeep: Math.max(1, asInt(cfg.checkpointsToKeep, "checkpointsToKeep", 128)),
  };
}

export function loadConfig(path: string, env: Record<string, string | undefined> = process.env): Config {
  const file = resolve(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    fail(`could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  return parseConfig(raw, dirname(file), env);
}

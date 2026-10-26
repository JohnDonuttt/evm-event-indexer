import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";

const addr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const abi = ["event Transfer(address indexed from, address indexed to, uint256 value)"];

const base = { rpcUrl: "http://localhost:8545", contracts: [{ name: "Token", address: addr, abi }] };

describe("parseConfig", () => {
  it("accepts a minimal config with inline human-readable ABI and fills defaults", () => {
    const cfg = parseConfig(base, "/tmp");
    expect(cfg.contracts[0]?.abi[0]).toMatchObject({ type: "event", name: "Transfer" });
    expect(cfg).toMatchObject({ port: 3000, pollMs: 2000, confirmations: 0n, batchSize: 2000n, checkpointsToKeep: 128 });
    expect(cfg.contracts[0]?.startBlock).toBe(0n);
    expect(cfg.dbPath).toBe("/tmp/indexer.db");
  });

  it("lets RPC_URL and PORT override the file", () => {
    const cfg = parseConfig(base, "/tmp", { RPC_URL: "http://override", PORT: "4000" });
    expect(cfg.rpcUrl).toBe("http://override");
    expect(cfg.port).toBe(4000);
  });

  it("loads an ABI from a plain JSON file and from a Foundry-style artifact", () => {
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    const plain = [{ type: "event", name: "Ping", inputs: [], anonymous: false }];
    writeFileSync(join(dir, "plain.json"), JSON.stringify(plain));
    writeFileSync(join(dir, "artifact.json"), JSON.stringify({ abi: plain, bytecode: "0x" }));

    for (const file of ["plain.json", "artifact.json"]) {
      const cfg = parseConfig({ ...base, contracts: [{ name: "A", address: addr, abi: file }] }, dir);
      expect(cfg.contracts[0]?.abi).toEqual(plain);
    }
  });

  it("reports readable errors", () => {
    expect(() => parseConfig({ contracts: base.contracts }, "/tmp")).toThrow(/no RPC endpoint/);
    expect(() => parseConfig({ ...base, contracts: [] }, "/tmp")).toThrow(/non-empty array/);
    expect(() => parseConfig({ ...base, contracts: [{ name: "A", address: "0x123", abi }] }, "/tmp")).toThrow(/valid address/);
    expect(() => parseConfig({ ...base, contracts: [{ name: "A", address: addr, abi: "missing.json" }] }, "/tmp")).toThrow(
      /could not read ABI file/,
    );
    expect(() => parseConfig({ ...base, pollMs: -5 }, "/tmp")).toThrow(/pollMs/);
  });

  it("rejects duplicate contract names", () => {
    const dup = { name: "Token", address: addr, abi };
    expect(() => parseConfig({ ...base, contracts: [dup, dup] }, "/tmp")).toThrow(/duplicate contract name/);
  });
});

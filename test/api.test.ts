import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Store } from "../src/store.js";
import { createApi } from "../src/api.js";

describe("api", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const store = new Store();
    store.commit(
      [
        { blockNumber: 1n, logIndex: 0, txHash: "0x1", blockHash: "0xb1", contract: "Token", event: "Transfer", args: { to: "0xaa" } },
        { blockNumber: 2n, logIndex: 0, txHash: "0x2", blockHash: "0xb2", contract: "Token", event: "Transfer", args: { to: "0xbb" } },
        { blockNumber: 3n, logIndex: 0, txHash: "0x3", blockHash: "0xb3", contract: "Token", event: "Approval", args: { to: "0xbb" } },
      ],
      [{ blockNumber: 3n, blockHash: "0xb3" }],
      10,
    );

    const contracts = [
      { name: "Token", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const, abi: [], events: [], startBlock: 7n },
    ];
    server = createApi(store, { contracts }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  it("reports health with the cursor", async () => {
    expect((await get("/health")).body).toEqual({ ok: true, cursor: "3" });
  });

  it("lists configured contracts", async () => {
    expect((await get("/contracts")).body).toEqual([
      { name: "Token", address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", startBlock: "7" },
    ]);
  });

  it("filters events by name and decoded argument", async () => {
    const { body } = await get("/events?event=Transfer&arg.to=0xbb");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].blockNumber).toBe(2);
  });

  it("pages using nextBefore", async () => {
    const first = (await get("/events?limit=2")).body;
    expect(first.events.map((e: { blockNumber: number }) => e.blockNumber)).toEqual([3, 2]);
    expect(first.nextBefore).toBe(2);

    const second = (await get(`/events?limit=2&before=${first.nextBefore}`)).body;
    expect(second.events.map((e: { blockNumber: number }) => e.blockNumber)).toEqual([1]);
  });

  it("validates input", async () => {
    expect((await get("/events?before=abc")).status).toBe(400);
    expect((await get("/events?arg.to'x=1")).status).toBe(400);
    expect((await get("/nope")).status).toBe(404);
    expect((await fetch(base + "/events", { method: "POST" })).status).toBe(405);
  });

  it("returns per-event counts", async () => {
    expect((await get("/stats")).body).toEqual([
      { contract: "Token", event: "Approval", count: 1 },
      { contract: "Token", event: "Transfer", count: 2 },
    ]);
  });
});

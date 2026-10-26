import { createServer, type Server } from "node:http";
import type { Config } from "./types.js";
import type { Store } from "./store.js";

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createApi(store: Store, config: Pick<Config, "contracts">): Server {
  return createServer((req, res) => {
    if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      switch (url.pathname) {
        case "/":
        case "/health":
          return send(res, 200, { ok: true, cursor: store.cursor()?.toString() ?? null });

        case "/contracts":
          return send(
            res,
            200,
            config.contracts.map((c) => ({ name: c.name, address: c.address, startBlock: c.startBlock.toString() })),
          );

        case "/stats":
          return send(res, 200, store.counts());

        case "/events": {
          // arg.<name>=<value> filters on decoded event arguments, e.g. ?event=Transfer&arg.to=0x…
          const args: Record<string, string> = {};
          for (const [key, value] of url.searchParams) {
            if (key.startsWith("arg.")) args[key.slice(4)] = value;
          }

          const limit = Number(url.searchParams.get("limit") ?? 50);
          const beforeParam = url.searchParams.get("before");
          if (beforeParam !== null && !/^\d+$/.test(beforeParam)) return send(res, 400, { error: "before must be a block number" });

          const events = store.query({
            contract: url.searchParams.get("contract") ?? undefined,
            event: url.searchParams.get("event") ?? undefined,
            args,
            limit: Number.isFinite(limit) ? limit : 50,
            before: beforeParam === null ? undefined : BigInt(beforeParam),
          });

          // pass this back as ?before= to get the next page
          const last = events[events.length - 1];
          return send(res, 200, { events, nextBefore: last ? last.blockNumber : null });
        }

        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("invalid argument name")) {
        return send(res, 400, { error: err.message });
      }
      console.error(err);
      return send(res, 500, { error: "internal error" });
    }
  });
}

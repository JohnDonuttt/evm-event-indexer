/**
 * Make decoded log args safe to store as JSON and easy to query:
 * bigint -> decimal string, address-looking strings -> lowercase, recurse into arrays/objects.
 */
export function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeValue(v)]));
  }
  return value;
}

export function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  // unnamed params come back as an array; keep them addressable as "0", "1", ...
  if (Array.isArray(args)) return Object.fromEntries(args.map((v, i) => [String(i), normalizeValue(v)]));
  return normalizeValue(args) as Record<string, unknown>;
}

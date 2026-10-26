import { describe, it, expect } from "vitest";
import { normalizeArgs, normalizeValue } from "../src/normalize.js";

describe("normalize", () => {
  it("turns bigints into decimal strings, including huge ones", () => {
    expect(normalizeValue(10n ** 30n)).toBe("1000000000000000000000000000000");
  });

  it("lowercases addresses but leaves other strings alone", () => {
    expect(normalizeValue("0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266")).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    expect(normalizeValue("Hello")).toBe("Hello");
    expect(normalizeValue("0xABCD")).toBe("0xABCD"); // not address-length
  });

  it("recurses into arrays and tuples", () => {
    expect(normalizeValue({ a: [1n, { b: 2n }] })).toEqual({ a: ["1", { b: "2" }] });
  });

  it("keeps unnamed params addressable by position", () => {
    expect(normalizeArgs([5n, true])).toEqual({ "0": "5", "1": true });
  });

  it("returns an empty object for events with no args", () => {
    expect(normalizeArgs(undefined)).toEqual({});
  });
});

import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { marketArg, nonNegativeInt, nonNegativeNumber } from "../src/cli.js";
import { MARKETS } from "../src/market.js";

describe("cli numeric parsers", () => {
  it("nonNegativeInt accepts valid, rejects junk/negative", () => {
    expect(nonNegativeInt("10")).toBe(10);
    expect(() => nonNegativeInt("abc")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("-1")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("NaN")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeInt("1.5")).toThrow(InvalidArgumentError);
  });
  it("nonNegativeNumber accepts decimals, rejects junk/negative", () => {
    expect(nonNegativeNumber("8.5")).toBe(8.5);
    expect(() => nonNegativeNumber("-2")).toThrow(InvalidArgumentError);
    expect(() => nonNegativeNumber("abc")).toThrow(InvalidArgumentError);
  });
});

describe("cli market parser", () => {
  it("marketArg resolves known codes, rejects unknown ones as a usage error", () => {
    expect(marketArg("cz")).toBe(MARKETS.cz);
    expect(marketArg("UK")).toBe(MARKETS.uk);
    expect(() => marketArg("de")).toThrow(InvalidArgumentError);
  });
});

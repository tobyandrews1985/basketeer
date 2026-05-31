import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";
import { nonNegativeInt, nonNegativeNumber } from "../src/cli.js";

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

import { describe, expect, it } from "vitest";

/**
 * The two published bins (cli, mcp-server) have side-effect-guarded bootstraps,
 * so importing them is safe and verifies they LOAD — catching missing direct
 * dependencies (e.g. zod), bad imports, or shebang/top-level regressions before
 * they ship. (The real wiring is exercised manually + by the unit suite.)
 */
describe("published bins load", () => {
  it("cli module imports without parsing argv", async () => {
    await expect(import("../src/cli.js")).resolves.toBeDefined();
  });

  it("mcp-server module imports without starting the server (catches missing deps)", async () => {
    await expect(import("../src/mcp-server.js")).resolves.toBeDefined();
  });
});

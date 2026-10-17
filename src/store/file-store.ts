import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MARKET, type Market, type MarketCode, resolveMarket } from "../market.js";
import type { Session } from "../models.js";
import type { TokenStore } from "./types.js";

/**
 * Default session file for a market: `~/.basketeer/session.json` for the UK
 * (unchanged from before markets existed), `~/.basketeer/session.<code>.json`
 * for every other market, so signing in to one storefront never overwrites
 * another's session.
 */
export function defaultSessionPath(market: Market = DEFAULT_MARKET): string {
  const file = market.code === DEFAULT_MARKET.code ? "session.json" : `session.${market.code}.json`;
  return join(homedir(), ".basketeer", file);
}

/**
 * Persists the session to a JSON file (garth-style): an explicit path, or
 * {@link defaultSessionPath} for `{ market }` (UK when omitted).
 */
export class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(location: string | { market?: MarketCode | Market } = {}) {
    this.path =
      typeof location === "string" ? location : defaultSessionPath(resolveMarket(location.market));
  }

  async load(): Promise<Session | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as Session;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async save(session: Session): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(session, null, 2), { mode: 0o600 });
    // writeFile's mode is a no-op if the file already existed with looser perms.
    await chmod(this.path, 0o600);
  }

  /** Note: does not securely erase — the file is unlinked, not shredded. */
  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

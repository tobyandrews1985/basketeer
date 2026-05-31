import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Session } from "../models.js";
import type { TokenStore } from "./types.js";

const DEFAULT_PATH = join(homedir(), ".basketeer", "session.json");

/** Persists the session to `~/.basketeer/session.json` (garth-style). */
export class FileTokenStore implements TokenStore {
  private readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
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

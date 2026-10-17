import type { Market } from "../market.js";
import { BrowserAuthBackend } from "./browser/playwright.js";
import { HttpAuthBackend } from "./http.js";
import type { AuthBackend } from "./types.js";

/**
 * Auth backends the CLI and MCP server can be configured with: `browser`
 * (sign-in + refresh in a real Chrome, works everywhere) or `http`
 * (browserless refresh, storefront-dependent; sign-in still needs `browser`).
 */
export const AUTH_BACKEND_KINDS = ["browser", "http"] as const;

export type AuthBackendKind = (typeof AUTH_BACKEND_KINDS)[number];

/** @throws {RangeError} for an unknown kind. */
export function parseAuthBackendKind(value: string): AuthBackendKind {
  const kind = value.trim().toLowerCase();
  if (!(AUTH_BACKEND_KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(
      `Unknown auth backend "${value}". Known backends: ${AUTH_BACKEND_KINDS.join(", ")}.`,
    );
  }
  return kind as AuthBackendKind;
}

export function createAuthBackend(kind: AuthBackendKind, market: Market): AuthBackend {
  return kind === "http" ? new HttpAuthBackend({ market }) : new BrowserAuthBackend({ market });
}

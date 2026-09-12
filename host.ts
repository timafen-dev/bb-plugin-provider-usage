// Runs on the machine whose Claude login is being asked about.
//
// The worker inherits its daemon's environment, so a daemon started with
// CLAUDE_CONFIG_DIR resolves that account and one without it resolves the
// default. BB's own probe reads os.homedir()/.claude either way, which is why
// two machines with two logins report the same account.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import {
  claudeDirectory,
  planLabel,
  windowsFromUsage,
  type ClaudeMachineUsage,
} from "./lib/claude-machine.js";
import {
  scanTokenFiles,
  usageHostContract,
  type FileCacheEntry,
} from "./lib/token-scan.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT_MS = 20_000;
let tokenFileCache = new Map<string, FileCacheEntry>();

async function readAccountEmail(directory: string): Promise<string | null> {
  // A sign-in writes the identity beside the credentials; the default location
  // also keeps one at the home root. Prefer the directory's own.
  for (const path of [
    join(directory, ".claude.json"),
    join(directory, "..", ".claude.json"),
  ]) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        oauthAccount?: { emailAddress?: unknown } | null;
      };
      const email = parsed.oauthAccount?.emailAddress;
      if (typeof email === "string" && email.length > 0) return email;
    } catch {
      // Try the next location.
    }
  }
  return null;
}

export default experimental_defineHostEntry({
  contract: usageHostContract,
  handlers: {
    claudeUsage: async (_input, context): Promise<ClaudeMachineUsage> => {
      const directory = claudeDirectory(process.env, homedir());
      const base = {
        directory,
        accountEmail: await readAccountEmail(directory),
        planLabel: null as string | null,
        windows: [] as ClaudeMachineUsage["windows"],
      };

      let credentials: Record<string, unknown>;
      try {
        const parsed = JSON.parse(
          await readFile(join(directory, ".credentials.json"), "utf8"),
        ) as { claudeAiOauth?: Record<string, unknown> };
        if (!parsed.claudeAiOauth) {
          return { ...base, status: "unauthenticated", message: null };
        }
        credentials = parsed.claudeAiOauth;
      } catch {
        return { ...base, status: "unauthenticated", message: null };
      }

      base.planLabel = planLabel(credentials);
      const token = credentials.accessToken;
      if (typeof token !== "string" || token.length === 0) {
        return { ...base, status: "unauthenticated", message: null };
      }
      const expiresAt = credentials.expiresAt;
      if (typeof expiresAt === "number" && expiresAt > 0 && Date.now() >= expiresAt) {
        return { ...base, status: "expired", message: null };
      }

      try {
        const response = await fetch(USAGE_URL, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "claude-code/2.1.0",
          },
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)]),
        });
        if (response.status === 401) {
          return { ...base, status: "expired", message: null };
        }
        if (!response.ok) {
          // Never echo the body: it can carry account detail.
          return {
            ...base,
            status: "error",
            message:
              response.status === 429
                ? "Claude usage is rate limited right now. Try again shortly."
                : `Claude usage request failed (HTTP ${response.status}).`,
          };
        }
        return {
          ...base,
          status: "ok",
          message: null,
          windows: windowsFromUsage(await response.json()),
        };
      } catch (cause) {
        return {
          ...base,
          status: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    tokenScan: async ({ force }) => {
      const scanned = await scanTokenFiles({
        cached: force === true ? new Map() : tokenFileCache,
      });
      tokenFileCache = new Map(
        scanned.files.map((file) => [
          file.path,
          {
            mtimeMs: file.mtimeMs,
            size: file.size,
            daily: file.daily,
            ...(file.keyedEvents ? { keyedEvents: file.keyedEvents } : {}),
            ...(file.blobCount != null
              ? { blobCount: file.blobCount, maxRowid: file.maxRowid }
              : {}),
          },
        ]),
      );
      // File paths stay on the selected machine. The server only needs the
      // bounded 90-day aggregate and cache counters.
      return {
        scannedAt: new Date().toISOString(),
        fileCount: scanned.files.length,
        changedFiles: scanned.changedFiles,
        sources: scanned.sources,
        daily: scanned.daily,
      };
    },
  },
});

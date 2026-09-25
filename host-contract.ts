// Shared between server.ts and host.ts.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const claudeMachineUsageSchema = z
  .object({
    status: z.enum([
      "ok",
      "stale",
      "unknown",
      "not_installed",
      "unauthenticated",
      "expired",
      "error",
    ]),
    accountEmail: z.string().nullable(),
    planLabel: z.string().nullable(),
    message: z.string().nullable(),
    directory: z.string(),
    windows: z.array(
      z
        .object({
          label: z.string(),
          usedPercent: z.number(),
          resetsAt: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const tokenBucketSchema = z
  .object({
    tokens: z.number(),
    input: z.number(),
    output: z.number(),
    cached: z.number(),
    reasoning: z.number(),
    turns: z.number(),
  })
  .strict();

export const machineTokensSchema = z
  .object({
    computer: z.string(),
    scannedAt: z.string(),
    changedFiles: z.number().int(),
    slices: z.array(
      z
        .object({
          provider: z.string(),
          location: z.string(),
          fileCount: z.number().int(),
          daily: z.record(z.string(), tokenBucketSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const hostContract = defineRpcContract({
  /** The Claude login this machine actually uses, not the one in $HOME. */
  claudeUsage: {
    input: z.null(),
    output: claudeMachineUsageSchema,
  },
  /**
   * This machine's own transcript history, as daily totals. The server can
   * only read its own disk, and the agents run somewhere else.
   */
  tokenHistory: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: machineTokensSchema,
  },
});

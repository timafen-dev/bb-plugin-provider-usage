// Shared between server.ts and host.ts.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { piSnapshotSchema } from "./lib/pi-usage-contract";

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
    codexSupplement: z.object({
      windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() }).strict()),
      credits: z.object({ hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullable() }).strict().nullable(),
      spendControl: z.object({ used: z.string(), limit: z.string(), remainingPercent: z.number(), resetsAt: z.string().nullable(), reached: z.boolean().nullable() }).strict().nullable(),
      resetCredits: z.object({ availableCount: z.number(), nextExpiresAt: z.string().nullable(), title: z.string().nullable(), description: z.string().nullable() }).strict().nullable(),
    }).strict().nullable().optional(),
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
          sourceId: z.string().optional(),
          cursorRepresentation: z.enum(["acp", "chats", "missing-acp", "missing-chats"]).optional(),
          observedAt: z.string().optional(),
          retained: z.boolean().optional(),
          readError: z.boolean().optional(),
          events: z.array(z.object({ atMs: z.number(), bucket: tokenBucketSchema }).strict()).optional(),
          keyedEvents: z.record(z.string(), z.object({ atMs: z.number(), bucket: tokenBucketSchema }).strict()).optional(),
          unknownWindow: tokenBucketSchema.optional(),
          birthMs: z.number().optional(),
          mtimeMs: z.number().optional(),
        })
        .strict(),
    ),
  })
  .strict();


/**
 * The Firstmate Pi snapshot read, as one machine reports it.
 *
 * Narrow on purpose. The input is `null`: there is no path, no root, no
 * command and no machine selector a caller could supply, because the location
 * is compiled into `lib/pi-usage-source.ts` and the owning machine is chosen
 * by the server from its own approved list. The output is the validated
 * artifact or a stable refusal code — never the file's raw text, never a
 * filesystem path and never an exception message.
 *
 * `version` is pinned so a machine running a newer plugin than the server
 * disagrees loudly instead of being half-understood.
 */
export const PI_HOST_READ_VERSION = 1;

const piArtifactFactSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z
    .object({
      state: z.literal("valid"),
      bytes: z.number().int().nonnegative(),
      snapshot: piSnapshotSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("refused"),
      reason: z.string().min(1).max(200),
      detail: z.string().min(1).max(500),
    })
    .strict(),
]);

const piSidecarFactSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent") }).strict(),
  z
    .object({ state: z.literal("failed"), errorClass: z.string().max(200).nullable() })
    .strict(),
  z.object({ state: z.literal("unreadable"), reason: z.string().min(1).max(200) }).strict(),
  z.object({ state: z.literal("unknown"), reason: z.string().min(1).max(200) }).strict(),
]);

export const externalPiUsageSchema = z
  .object({
    version: z.literal(PI_HOST_READ_VERSION),
    artifact: piArtifactFactSchema,
    sidecar: piSidecarFactSchema,
    bytes: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ExternalPiUsageRead = z.infer<typeof externalPiUsageSchema>;

export const hostContract = defineRpcContract({
  /** The Claude login this machine actually uses, not the one in $HOME. */
  claudeUsage: {
    input: z.union([z.null(), z.object({ codexAccountEmail: z.string().min(1) }).strict()]),
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
  /**
   * One confined read of this machine's fixed Firstmate Pi export location.
   * Read-only, and nothing about it is live: the server only asks the one
   * approved owning machine, and only when something asks the server.
   */
  externalPiUsage: {
    input: z.null(),
    output: externalPiUsageSchema,
  },
});

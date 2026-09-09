// Shared between server.ts and host.ts.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const claudeMachineUsageSchema = z
  .object({
    status: z.enum(["ok", "not_installed", "unauthenticated", "expired", "error"]),
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

export const hostContract = defineRpcContract({
  /** The Claude login this machine actually uses, not the one in $HOME. */
  claudeUsage: {
    input: z.null(),
    output: claudeMachineUsageSchema,
  },
});

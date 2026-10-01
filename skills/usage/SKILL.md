---
name: usage
description: Inspect remaining provider subscription usage, plans, reset windows, live token throughput, and global token totals. Use when the user asks about usage, quota, remaining limits, what is burning tokens right now, token spend over time, Codex/Claude/Cursor plan usage, or when to wait for a reset.
---

# Usage dashboard

Run `bb usage subscriptions --json` to see every paid plan once — provider +
account across all paired machines — with its live or last-known quota. Run
`bb usage --machine <id-or-name>` for one machine. Bare `bb usage` prints the
plans first and then the BB server's own limits, which are not a paired
machine's.

```bash
bb usage subscriptions --json # each plan once: status ok|stale|unknown, windows, readFrom, machines[]
bb usage
bb usage --json
bb usage live                 # tokens per minute right now, by provider and thread
bb usage tokens --days 30
bb usage --machine <id-or-name>
bb usage accounts --json      # raw per-machine rows, local auth state included
```

In `subscriptions[]`, `status: "stale"` means the shown windows are the last
successful reading (`readFrom.checkedAt` says when); `machines[]` carries each
machine's own state (`unauthenticated`, `expired`, `unknown`) and is not the
plan's quota. An exhausted plan is `ok` with `remainingPercent: 0`.

Use `totals.cumulativeRemainingPercent` for remaining quota across signed-in
providers, `totals.tightest` for the most exhausted window, and each provider
`windows[].remainingPercent` when deciding whether a thread should wait for a
reset. Provider rows may also include `credits`, `resetCredits`, and
`spendControl`; for Codex these expose purchased-credit balance, banked reset
availability/expiry, and any backend-reported on-demand period. A window's
`cost` gives exact used/limit dollars when the provider reports them. Use
`tokens.totals` and `tokens.providers` for global Codex/Claude transcript token
volume across Codex, Claude Code, Cursor, and opencode.

`bb usage live` answers "what is being burned right now": `tokensPerMinute` is
the trailing-60-second rate, `peakTokensPerMinute` the best rate in the last 15
minutes, and `threads[]` attributes it to the threads doing the work. Archived
and deleted threads are omitted. It counts only what BB drives, so an agent
run outside BB does not appear.

# Provider Usage

A BB panel for **what you are burning right now**, **how much of your plan is
left**, and **how many tokens you have spent** — across every provider you are
signed in to, on every machine BB knows about.

<!-- screenshot: docs/panel.png -->

## What it shows

**Live throughput.** A 15-minute chart of tokens as they are reported, binned
per 10 seconds and stacked by provider, with the current rate over the trailing
60 seconds, the best rate seen in the window, and the threads doing the work. It
updates every couple of seconds while a turn is running and settles when the
machine goes quiet. Archived and deleted threads drop out immediately — they
are history, not current burn. BB's token events are authoritative; for
BB-launched ACP sessions whose bridges do not emit them, the plugin maps the
provider thread id back to opencode's exact local counters or Cursor's
text-derived estimate.

**Provider limits.** One pane, one row per provider: its plan, each
rate-limit window (5-hour, weekly, monthly — whatever the provider reports), how
much is left, and when it comes back. Every meter counts **down** — the ring,
the bar, and the number all show what remains, the way each provider states its
own limits. Cost-backed windows also show the amount used and the period cap.
A provider bb ships stays listed even when it is not installed, because that is
real news; a plugin-supplied provider such as Muse Code appears only once its
plugin is installed.

On the primary machine, Codex adds purchased-credit balance, banked reset count
and expiry, model-specific limit buckets, and any on-demand spend control the
Codex backend reports.

**Token usage, for every provider.** A 7 / 30 / 90-day multi-series chart of
real token volume, broken out into total, uncached input, output, and cached,
per provider. Total follows the provider's canonical count where one is
available and includes cached input; the cached field is also retained as a
breakdown. Cursor's ACP stores do not include token counters, so its series is
estimated from the recorded conversation text. The data reads from two tiers:

- **Transcript scanners** for the agents that keep detailed local records —
  Codex (`~/.codex`, or `$CODEX_HOME`), Claude Code (`~/.claude`, or
  `$CLAUDE_CONFIG_DIR`), Cursor's ACP session stores, opencode
  (`~/.local/share/opencode`, or `$XDG_DATA_HOME/opencode`), and Muse Code
  (`~/.local/share/muse`, or `$MUSE_HOME`/`$XDG_DATA_HOME`). These give full
  history and exact per-day attribution, back to before you installed BB.
- **BB's own usage events** for everything else. As soon as a provider emits
  `thread/tokenUsage/updated`, an agent this plugin has never heard of — a new
  ACP agent, one you wrote yourself — lands in the chart automatically, with a
  name and a colour of its own. No release here required.

Providers with a dedicated scanner are excluded from the second tier, so
nothing is counted twice.

**Multi-machine.** If you have more than one host paired, a machine picker
switches the whole view between them.

**Source selector.** A *BB-native / Firstmate Pi* control at the top of the page
chooses which dataset you are looking at. Native is everything above and is
unchanged by its presence; Pi is one external producer's recorded task usage,
read as its own dataset and never folded into a native total or a plan's
remaining quota. See [Firstmate Pi, as a separate
source](#firstmate-pi-as-a-separate-source) — it is implementation-ready, not
live.

It also contributes a homepage section and a sidebar accessory, so the tightest
window follows you around without opening the panel.

## Install

From the BB marketplace:

```bash
bb plugin install provider-usage
```

Or from a local checkout:

```bash
git clone https://github.com/braedonsaunders/bb-plugin-provider-usage.git
cd bb-plugin-provider-usage
npm install --include=dev
bb plugin install . --yes
```

Open **Usage** in the left sidebar.

## CLI

```bash
bb usage                          # remaining quota, plans, reset windows
bb usage --json                   # same, machine-readable
bb usage accounts --json          # separate Codex/Claude identity + status per machine
bb usage live                     # what is being burned right now, by thread
bb usage tokens --days 30         # global token volume across providers
bb usage --machine <id-or-name>   # read another paired host
```

Agents get the same data through the bundled `usage` skill, which is how a
long-running thread can decide whether to keep going or wait for a reset.

## How it works

Subscription windows come from BB's own `system.usageLimits` for each signed-in
provider. On the primary machine, a read-only `codex app-server` request fills
in newer Codex fields that BB's provider-neutral schema does not yet carry. It
uses the existing Codex sign-in and never reads, stores, or returns auth tokens.
If the installed Codex version does not support the request, the panel silently
falls back to BB's regular windows.

`bb usage accounts` keeps provider and machine sources separate. A missing
machine-specific source is reported as `unknown`; an exhausted window remains
`ok` with `remainingPercent: 0`; an expired or absent login remains
`expired`/`unauthenticated`. Last-known values used during a rate-limit response
are marked `stale`, never fresh. Codex credits and banked-reset enrichment is
primary-only, so remote rows intentionally leave those fields null instead of
copying credentials between machines.

The on-demand amount shown here is a provider-reported spend-control period. It
is separate from organization-wide OpenAI Platform API billing. Exact Platform
API spend comes from OpenAI's Costs API and requires an organization admin key;
this plugin does not ask for or store one.

Token totals come from a background `token-scan` service that walks local
transcript files, caches per-file results in the plugin's SQLite database, and
re-syncs every 15 minutes. Only sources whose size or mtime changed are re-read,
so a large history stays cheap. Nothing is uploaded anywhere.

The same pass asks BB for `thread/tokenUsage/updated` on any thread whose
provider has no dedicated scanner. Those events carry the thread's *running*
total rather than the turn's, so consecutive events are differenced; a total
that goes backwards means the thread was compacted or restarted upstream and is
read as a fresh total rather than a negative one.

Live throughput is a separate, deliberately different path: a
`throughput-scan` service follows `thread/tokenUsage/updated` for every provider
that emits it, polling every two seconds while a thread is working and every ten
when none is. Some ACP bridges currently omit that event. For BB-launched
opencode and Cursor sessions, a local fallback resolves BB's persisted
`thread/identity` to the matching provider session and reads only that session's
store. Native events always win, so the two paths never count the same thread.
Work run outside BB, such as an agent CLI in a bare terminal, remains excluded.

Attribution is the subtle part. Those events carry the thread's *running* total,
so consecutive events are differenced. The first event seen for a thread has
nothing to difference against, and providers report it very differently: BB's
Claude Code bridge has been seen emitting a single event whose running total is
98.7M and whose `last` is 55.9M — usage since the session resumed, hours of it,
not one step. Charting either figure raw drops tens of millions of tokens onto
one instant. So a thread's first event is charted only when the thread itself is
younger than the window, because then its whole history is inside the window by
definition; otherwise it becomes the baseline and every event after it
differences correctly. The cost is one uncharted turn per thread when the
service starts.

The two charts share one palette, seated per provider rather than per rank, so a
provider is the same colour in both and keeps that colour as other series come
and go. The slots are checked rather than eyeballed: each sits in its mode's
lightness band, clears the chroma floor, holds 3:1 against the surface, and keeps
neighbouring slots apart under simulated protanopia and deuteranopia.

A caveat worth stating plainly: the event fallback only sees what a provider
actually reports. Providers that neither emit `thread/tokenUsage/updated` nor
have a supported local store will show subscription windows but no token
series, and some agents (Factory Droid, Hermes) keep no usable per-turn token
record on disk at all.

## Firstmate Pi, as a separate source

Firstmate Pi runs agent work outside BB. None of the paths above can see it:
there is no BB thread emitting `thread/tokenUsage/updated`, no transcript root
that this plugin compiles in, and no provider login to ask. Rather than invent a
thread or fold the work into a provider row, Pi is read as its **own source**,
through one bounded, sanitized, read-only snapshot file that the Pi side writes.

The producer and its wire format are not defined here. The canonical contract is

<https://github.com/timafen-dev/agentic-engineering/blob/b8770582bd78ed5d362750950f93756eec105c99/tools/subscription_usage/PI_USAGE.md>

and this repository pins what that document states: wire `schema_version: 1`,
`kind: pi_usage_snapshot`, producer alias `firstmate-pi`, private ledger schema
2, parser `pi-usage-parser/2`, source schema `pi-session-jsonl/1`. A snapshot
that disagrees on any of those is refused rather than read loosely — including a
ledger-1 artifact, which the producer itself refuses.

### What the figures are, and are not

The USD in a Pi snapshot is the **API-equivalent estimate Pi itself recorded for
the request**. It is not an invoice, not a payment, and not subscription quota
consumption, so none of it is added to this panel's native totals and no share
of it is subtracted from a plan's remaining quota. Remaining quota and reset
windows stay exactly where they are: the subscriptions view, fed by BB's own
providers. Nothing in the Pi path touches them.

Two distinctions are kept rather than flattened, because collapsing either would
make a believable figure that is not true:

- **Pi is a source harness, not a provider.** It is where the work ran, not who
  served the tokens.
- **A requested model is a requested identity.** When the producer did not
  record a served model, the served model is unknown — not confirmed to be the
  requested one.

A known sum of `0` with no priced call is **unknown spend**, not a free hour.
Known USD is carried as exact decimal digits with an exact companion; rounding
happens only on the way to the screen, and there is no repricing from today's
catalogue. Input, cache read, cache write and output stay four separate numbers,
and `reasoning` is a possible *subset* of output that is never added to it
again. The current context size is unknown — a cache read is not the context.

### Nothing becomes a zero

A snapshot the panel cannot read is never shown as an idle hour. Missing,
oversized, unparseable, refused, stale, generated-in-the-future, and
producer-reported-failed are each their own state, and only the producer may
declare a source idle, through `verified_idle_zero`. Last-good figures may be
displayed, but always marked degraded — never as a current reading.

Freshness comes from the snapshot's own `generated_at`, never a file's
modification time, so rewriting an old export does not make it look new. Each
snapshot is a complete replacement dataset: polling twice yields the same
totals, and nothing is ever accumulated or billed again. A producer failure note
(`<artifact>.status.json`) outranks whatever artifact is on disk, because the two
are replaced atomically but not in one transaction, so the file beside a failure
note may be an older generation. A note the panel cannot parse still counts as a
failure — the dangerous reading of a broken note is the reassuring one.

The views — tasks, roles, requested models, work items — are **overlapping
dimensions** over the same calls, not additional totals, and must not be summed
together. One task key already combines its author and No Mistakes work; a
response copied into an NM fork counts once. MAIN work with no proved binding
stays under the reserved `main_unassigned` key rather than being attributed to a
task. A folded `others` row is an aggregate, never a real task and never a BB
thread.

### Where it reads from, and what it refuses

One machine, one location, compiled in:

```
~/.local/state/pi-usage/snapshot.json              the artifact
~/.local/state/pi-usage/snapshot.json.status.json  the producer's failure note
```

That is the location the producer's own documented `export` operation writes,
and the plugin names it in source rather than taking it from a caller. The host
read `externalPiUsage` therefore takes **`null`** as its input: there is no
path, root, command or machine selector an RPC could supply, so no caller can
ask this plugin to read a file of its choosing. The machine that is asked is
the one approved owning machine (`homeserver` in the holding's machine list),
resolved by the server from its own machine list — other machines are never
swept, two machines answering to that name are an ambiguity rather than a pair
to add up, and an unknown or offline owning machine is reported as unavailable.

The read itself is designed to be refusable:

- a link under either name is **refused, not followed**, so the agreed file
  name cannot be pointed at a session transcript or an auth store;
- the export directory must resolve inside the owning account's own home;
- anything that is not a regular file is refused;
- the size is bounded at the agreed 2 MiB **before** any byte is decoded, and
  the read stops one byte past the bound, so a file that grows between the
  check and the read still cannot be loaded;
- a note that exists but cannot be read stays a failure, while a note that
  could not be *looked for* at all is neither a failure nor an absence: it
  cannot clear a failure the previous poll saw, and the figures beside it are
  shown as degraded rather than current.

No session, transcript, credential or auth store is opened anywhere on this
path, and a refusal travels as a stable code with fixed wording — never a path,
a home directory, a machine name or an exception message.

### How the page asks for it

The page reads Pi through one server RPC, `getExternalPiUsage`, whose input is
also **`null`** — the same reason as the host read: no path, no root, no command
and no machine selector is expressible, so the only thing a caller can ask is
"what does the one approved location hold right now". Its output is the
validated *reading*: a named state (`ok`, `stale`, `future`, `unavailable`,
`missing`, `invalid`, `failed`), a stable reason code, sanitized wording, and
either the producer's schema-checked snapshot or `null` — never loose JSON and
never a zero stand-in. A machine answering with a read this plugin does not
understand is reported as incompatible rather than half-understood.

Exactly two facts live between one read and the next: the last snapshot actually
read, and whether the last poll that reached the location saw a producer failure
note. Nothing else crosses — no running totals, no counters, no merged
snapshots — so asking twice yields the same figures. Remembering the failure note
is what lets a successful retry be *observed*: only the real absence of a note
clears it, while a read that never reached the location leaves the previous
verdict standing and reports no recovery. The memory is in process only, so a
restart simply has no last-good figures to show, which is an honest unavailable
state rather than a zero. Two asks arriving together share one read: a
replacement dataset read twice at the same instant is the same dataset, and two
races would each overwrite what the other observed — including a failure note
that had just been cleared.

Native RPCs are untouched: `getDashboard`, `getTokens`, `getThroughput` and the
free-tokens read return exactly what they did before, and no Pi figure enters any
of them.

### What the lens shows on the page

The Usage page carries a **source selector**: *BB-native* or *Firstmate Pi*. It
picks a dataset, not a filter. On *BB-native* the page is exactly what it always
was — live throughput, the token chart, free tokens and the per-machine
subscription panes, polling as before. On *Firstmate Pi* those sections unmount,
their polls stop, and one Pi section takes their place. Nothing is merged in
either direction, and the subscriptions view stays the single native section it
has always been: remaining quota and reset windows are account-wide facts and
are never attributed to a Pi task.

The Pi section leads with its state, because a figure is only worth as much as
the reading behind it. The badge reads as good only for a first-hand, in-cadence
export whose window the producer reports as fully covered; a stale or
future-stamped export, a retained last-known figure, a producer failure, a
partial window or a quarantined record all read as degraded instead, each with
its own wording. Age comes from the export's own `generated_at` — never a file
time, never the time the page asked — and the observation lag and
completed-response basis are shown beside it, because these are recorded
responses, not a live stream.

Below that are the figures, as the producer reports them:

- **Tasks**, with the author and No-Mistakes work on a task already combined,
  the producer's own task key as the label, its title when there is one, and up
  to four approved GitHub issue or pull-request links. No bb thread, event or
  provider identity is invented for Pi work, because it has none.
- **Work items** (`task · role`), **roles** and **requested models**. These are
  the same calls sliced four ways — overlapping views of one membership, not
  four amounts to add up. A `others` row (`other` for models) is a fold of the
  rows past the producer's limit, not a task. **MAIN, unassigned** keeps its own
  block: MAIN work the producer could not bind to a task stays unassigned.
- **Recorded USD** per row and for the dataset, labelled as Pi's own
  API-equivalent estimate, with how many calls were priced, how many are missing
  a price and how many carried an unusable cost. A sum of zero with no priced
  call shows as `—` and reads *unknown spend*; a priced call that genuinely cost
  nothing shows as `$0.00`. Rounding happens only on the way to the screen, to
  cents where cents can show the amount and to the producer's six places when
  they cannot.
- **Tokens**, as four separate numbers plus reasoning. Reasoning is a possible
  subset of output and is never added into the total. The current context is
  shown as unknown, because the producer does not record it and a cache read is
  not the context.
- **A chart** over the producer's own series — 10-second live bins, hours, or
  days. Points are placed by time rather than by row index, so a stretch the
  producer recorded nothing in stays visibly empty: an absent bin means no
  recorded completed response, which is not the same as a source the producer
  verified as idle. Hour identities keep the offset they were recorded with, so
  the two repeated local hours of a 25-hour day stay two distinct points.
- **Coverage**: declared sources with their per-source status, and the counters
  for everything that was not read — unreadable locations, never-ingested
  sources, conflicting bindings, ambiguous forks, token-field gaps, responses
  without usage, skipped rows and quarantined records.

Each poll replaces the previous reading outright, so leaving the lens open does
not accumulate anything, and the poll stops when the section is unmounted.

### Activation is a separate, approved step

This is **implementation-ready, not installed and not live**. Reading a snapshot
needs a source change in this repository *plus* a tested release — not a config
toggle and not a flag. Separately from the plugin work, turning it on requires
its own approval for where the snapshot is placed, how that location is mounted,
and what permissions it carries. No timer, no polling, and no live wiring is
installed by the adapter: it reads one fixed, confined location on one
explicitly approved owning machine, and an unknown or unreachable owning machine
is reported as unavailable rather than falling back to native data or to zero.
When polling is eventually enabled, the expected cadence is a 30-second tick
with a 90-second grace; that is also the cadence the page's Pi section asks at
while it is open, which is the only timer any of this installs.

Until the snapshot location is approved and populated, selecting the Pi lens on
a machine without it is honest about exactly that: it reports the owning machine
as unavailable or the snapshot as not placed, and shows no figures — not a zero.

## Develop

```bash
npm install --include=dev
bb plugin install .
bb plugin dev
```

## Upgrading from `bb-plugin-dashboard`

This plugin was previously called `dashboard` and its CLI was `bb dashboard`.
The panel, data, and layout are unchanged — the id is now `provider-usage` and
the command is `bb usage`. If you installed the old one from a path, remove it
before installing this one:

```bash
bb plugin remove dashboard
bb plugin install provider-usage
```

To keep your token history, copy the old plugin's database across before
installing:

```bash
cp ~/.bb/plugins/dashboard/data.db ~/.bb/plugins/provider-usage/data.db
```

It is not the same plugin as the marketplace's `usage`, `usage-page`, or
`usage-tracker` entries, which track token spend and estimated API cost. This
one leads with **remaining plan quota and reset windows**, and reads token
volume off local transcripts rather than pricing it.

## Licence

MIT © Braedon Saunders

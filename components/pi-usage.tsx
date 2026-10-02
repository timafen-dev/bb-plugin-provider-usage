/**
 * The Firstmate Pi lens of the Usage page.
 *
 * This section renders one external producer's recorded snapshot: its tasks,
 * work items, roles and requested models, the USD it recorded, how much of its
 * window it could read, and how old the reading is. It is a separate dataset
 * from everything else on the page — no figure here is added to a native
 * total, and no subscription remaining or reset is attributed to a Pi task.
 *
 * Every presentation decision — which zero is verified, which badge may read
 * as good, what a money cell says, where a point sits in time — comes from
 * `lib/pi-usage-view.ts`, which is tested against the producer's own fixture.
 * This file is the markup for it.
 *
 * Pi work has no bb thread, event or provider identity, and none is invented
 * here: a task is the producer's own key, and the only links are the approved
 * GitHub issue and pull-request links the backend already validated.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PI_TICK_SECONDS } from "@/lib/pi-usage-shape";
import type { PiReading } from "@/lib/pi-usage-contract";
import {
  piPointFraction,
  piUsageView,
  type PiDimensionView,
  type PiFiguresView,
  type PiPointView,
  type PiRowView,
  type PiSeriesId,
  type PiSeriesView,
  type PiTone,
  type PiUsageView,
} from "@/lib/pi-usage-view";
import { formatTokenCount } from "@/lib/tokens";
import { Skeleton } from "@/components/usage-skeletons";

/** The producer's expected export cadence; asking faster learns nothing. */
const POLL_MS = PI_TICK_SECONDS * 1_000;
const CHART_HEIGHT = 168;
const PAD = { left: 48, right: 10, top: 14, bottom: 22 };

const SERIES_TABS: { id: PiSeriesId; label: string }[] = [
  { id: "live", label: "Live" },
  { id: "hours", label: "Hours" },
  { id: "days", label: "Days" },
];

/**
 * One read of the Pi snapshot.
 *
 * Each answer replaces the last one outright: a snapshot is a complete
 * dataset, so nothing here adds a poll to the one before it and polling twice
 * cannot double a total. The interval lives and dies with the mounted section,
 * a read in flight is never joined by a second one, and an answer that arrives
 * after unmount is dropped rather than applied.
 */
function usePiUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const [reading, setReading] = useState<PiReading | null>(null);
  // Whether the ask itself failed, as a flag rather than a message: a transport
  // error's text is not sanitized wording and has no business on the page.
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inflight = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const next = await rpc.call("getExternalPiUsage", null);
      if (!alive.current) return;
      // Replacement, not accrual.
      setReading(next as PiReading);
      setNowMs(Date.now());
      setFailed(false);
    } catch {
      if (!alive.current) return;
      setFailed(true);
    } finally {
      inflight.current = false;
      if (alive.current) setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { reading, failed, loading, nowMs, reload: load };
}

function toneBadge(tone: PiTone): string {
  if (tone === "ok") return "border-success/40 bg-success/10 text-success";
  if (tone === "degraded") return "border-primary/40 bg-primary/10 text-primary";
  return "border-border bg-muted/40 text-muted-foreground";
}

function Badge({
  tone,
  children,
}: {
  tone: PiTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
        toneBadge(tone),
      )}
    >
      {children}
    </span>
  );
}

function Tile({
  label,
  value,
  hint,
  muted,
}: {
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <Card className="shadow-none">
      <CardContent className="space-y-1 p-4">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "text-xl font-semibold tabular-nums tracking-tight",
            muted ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {value}
        </p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function useMeasuredWidth<T extends HTMLElement>() {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    const next = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      setWidth((current) =>
        Math.abs(current - measured) < 0.5 ? current : measured,
      );
    });
    next.observe(node);
    observer.current = next;
    setWidth(node.clientWidth);
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return [ref, width] as const;
}

/**
 * The recorded series, drawn on a time axis rather than a row index, so a
 * stretch the producer emitted nothing for stays visibly empty. Bars are
 * recorded tokens; the count of completed responses is in the readout.
 */
export function PiUsageSeriesChart({
  series,
  width,
}: {
  series: PiSeriesView;
  width: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = CHART_HEIGHT - PAD.top - PAD.bottom;
  const axisMax =
    series.peakRecordedTokens <= 0 ? 1 : series.peakRecordedTokens / 0.9;
  const yAt = (value: number) => PAD.top + innerH * (1 - value / axisMax);

  const bars = series.points.flatMap((point) => {
    const span = piPointFraction(series, point);
    if (span === null) return [];
    const x = PAD.left + span.start * innerW;
    const full = Math.max(1, (span.end - span.start) * innerW);
    return [{ point, x, width: Math.min(full, Math.max(3, full - 2)) }];
  });

  const active =
    hover === null ? null : (series.points.find((point) => point.key === hover) ?? null);

  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    let nearest: { key: string; distance: number } | null = null;
    for (const bar of bars) {
      const centre = bar.x + bar.width / 2;
      const distance = Math.abs(centre - x);
      if (nearest === null || distance < nearest.distance) {
        nearest = { key: bar.point.key, distance };
      }
    }
    setHover(nearest && nearest.distance <= Math.max(16, innerW / 12) ? nearest.key : null);
  };

  const ticks = [0, 0.5, 1];

  return (
    <div className="space-y-2">
      <svg
        width={width}
        height={CHART_HEIGHT}
        className="block touch-none select-none"
        role="img"
        aria-label={`Firstmate Pi recorded tokens, ${series.title.toLowerCase()}`}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + innerW}
              y1={yAt(axisMax * tick)}
              y2={yAt(axisMax * tick)}
              className="stroke-border"
              strokeWidth="1"
              shapeRendering="crispEdges"
            />
            <text
              x={PAD.left - 8}
              y={yAt(axisMax * tick) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {formatTokenCount(axisMax * tick)}
            </text>
          </g>
        ))}

        {bars.map((bar) => {
          const height = Math.max(
            bar.point.tokens.recorded > 0 ? 2 : 0,
            PAD.top + innerH - yAt(bar.point.tokens.recorded),
          );
          if (height <= 0) return null;
          return (
            <rect
              key={bar.point.key}
              x={bar.x}
              y={PAD.top + innerH - height}
              width={bar.width}
              height={height}
              rx="2"
              className={cn(
                active && active.key === bar.point.key
                  ? "fill-foreground"
                  : "fill-foreground/60",
              )}
            />
          );
        })}

        {series.points.length === 0 ? (
          <text
            x={PAD.left + innerW / 2}
            y={PAD.top + innerH / 2}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            No recorded points in this range
          </text>
        ) : null}

        <text
          x={PAD.left}
          y={CHART_HEIGHT - 6}
          className="fill-muted-foreground text-[10px]"
        >
          {series.points[0]?.label ?? ""}
        </text>
        <text
          x={PAD.left + innerW}
          y={CHART_HEIGHT - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[10px]"
        >
          {series.points.length > 1 ? (series.points.at(-1)?.label ?? "") : ""}
        </text>
      </svg>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">
          {active
            ? `${active.label} · ${active.tokens.recordedText} tokens · ${active.calls} completed ${active.calls === 1 ? "response" : "responses"} · ${active.money.text}`
            : series.note}
        </span>
        {series.covers ? (
          <span className="tabular-nums text-muted-foreground/70">
            {series.binSeconds}s bins · {series.points.length} recorded
          </span>
        ) : (
          <span className="tabular-nums text-muted-foreground/70">
            {series.points.length} recorded
          </span>
        )}
      </div>
    </div>
  );
}

function RowTokens({ row }: { row: PiRowView }) {
  return (
    <span className="tabular-nums text-muted-foreground">
      {row.tokens.inputText} in · {row.tokens.cacheReadText} cache r ·{" "}
      {row.tokens.cacheWriteText} cache w · {row.tokens.outputText} out
      {row.tokens.reasoning > 0 ? (
        <span title="A possible subset of output, never added to it">
          {" "}
          · {row.tokens.reasoningText} reasoning
        </span>
      ) : null}
    </span>
  );
}

function DimensionTable({ dimension }: { dimension: PiDimensionView }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium">{dimension.title}</p>
        <p className="text-xs text-muted-foreground">{dimension.note}</p>
      </div>
      {dimension.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No rows recorded for this view in the window.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {dimension.rows.map((row) => (
            <div
              key={row.key}
              className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 p-3 text-xs"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-foreground">
                    {row.taskPart && row.rolePart ? (
                      <>
                        {row.taskPart}
                        <span className="text-muted-foreground"> · {row.rolePart}</span>
                      </>
                    ) : (
                      row.label
                    )}
                  </span>
                  {row.folded ? <Badge tone="degraded">folded</Badge> : null}
                  {row.unassigned ? <Badge tone="degraded">unassigned</Badge> : null}
                  {row.tokens.gaps > 0 ? (
                    <Badge tone="degraded">{row.tokens.gaps} token gaps</Badge>
                  ) : null}
                </div>
                {row.sublabel ? (
                  <p className="text-muted-foreground">{row.sublabel}</p>
                ) : null}
                {row.links.length > 0 ? (
                  <p className="flex flex-wrap gap-x-3">
                    {row.links.map((link) => (
                      <a
                        key={link}
                        href={link}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {link.replace("https://github.com/", "")}
                      </a>
                    ))}
                  </p>
                ) : null}
                <RowTokens row={row} />
              </div>
              <div className="shrink-0 space-y-0.5 text-right">
                <p
                  className={cn(
                    "font-medium tabular-nums",
                    row.money.kind === "known"
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                  title={row.money.exactText ?? row.money.note}
                >
                  {row.money.text}
                </p>
                <p className="tabular-nums text-muted-foreground">
                  {row.calls} {row.calls === 1 ? "call" : "calls"}
                </p>
                <p className="text-muted-foreground/70">{row.money.coverageText}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CoveragePanel({ figures }: { figures: PiFiguresView }) {
  const { coverage } = figures;
  const shown = coverage.counters.filter(
    (counter) => counter.value > 0 || !counter.gap,
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">Coverage</p>
        <Badge tone={coverage.tone}>{coverage.label}</Badge>
        <span className="text-xs text-muted-foreground">
          {coverage.declaredSources} declared{" "}
          {coverage.declaredSources === 1 ? "source" : "sources"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {shown.map((counter) => (
          <span key={counter.id} className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">{counter.label}</span>
            <span
              className={cn(
                "tabular-nums",
                counter.gap && counter.value > 0
                  ? "text-primary"
                  : "text-foreground",
              )}
            >
              {counter.value}
            </span>
          </span>
        ))}
      </div>
      {coverage.sources.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {coverage.sources.map((source) => (
            <span key={source.alias} className="inline-flex items-center gap-1.5">
              <span className="text-muted-foreground">{source.alias}</span>
              <span className="tabular-nums text-foreground">
                {source.entries} {source.entries === 1 ? "entry" : "entries"}
              </span>
              <Badge tone={source.tone}>{source.statusLabel}</Badge>
            </span>
          ))}
        </div>
      ) : null}
      {coverage.quarantined > 0 ? (
        <p className="text-xs text-primary">
          {coverage.quarantined} quarantined{" "}
          {coverage.quarantined === 1 ? "record" : "records"} — a coverage gap, not
          spend.
        </p>
      ) : null}
      {coverage.warnings.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {coverage.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The figures themselves, split from the section so a test can render this
 * tree for a prepared reading: the section's own reading arrives from an
 * effect, which a static render never runs.
 */
export function PiUsageFigures({ view }: { view: PiUsageView }) {
  const figures = view.figures;
  const [tab, setTab] = useState<PiSeriesId>("live");
  const [chartRef, width] = useMeasuredWidth<HTMLDivElement>();
  if (!figures) return null;
  const series = figures.series[tab];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          label="Recorded tokens"
          value={figures.tokens.recordedText}
          hint="Input, cache read, cache write and output; reasoning is a subset of output and is not added in"
        />
        <Tile
          label="Recorded USD"
          value={figures.cost.text}
          muted={figures.cost.kind !== "known"}
          hint={
            figures.cost.kind === "known"
              ? `API-equivalent estimate · ${figures.cost.coverageText}`
              : figures.cost.note
          }
        />
        <Tile
          label="Completed responses"
          value={figures.cost.calls.toLocaleString()}
          hint={`${figures.observation.basisText} · lag ${figures.observation.lagText}`}
        />
        <Tile
          label="Source age"
          value={view.status.ageText ?? "—"}
          muted={view.status.tone !== "ok"}
          hint={`From the export's own generated_at · ${figures.coverage.label.toLowerCase()} coverage`}
        />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        {[
          { label: "Input", value: figures.tokens.inputText, title: figures.inputNote },
          { label: "Cache read", value: figures.tokens.cacheReadText, title: "Recorded cache reads; not the current context" },
          { label: "Cache write", value: figures.tokens.cacheWriteText, title: "Recorded cache writes" },
          { label: "Output", value: figures.tokens.outputText, title: "Recorded output" },
          { label: "Reasoning", value: figures.tokens.reasoningText, title: figures.reasoningNote },
          { label: "Current context", value: "unknown", title: figures.observation.currentContextText },
        ].map((item) => (
          <span
            key={item.label}
            className="flex items-baseline justify-between gap-2"
            title={item.title}
          >
            <span className="text-muted-foreground">{item.label}</span>
            <span className="tabular-nums text-foreground">{item.value}</span>
          </span>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{series.title}</p>
          <div className="flex rounded-md border border-border p-0.5">
            {SERIES_TABS.map((option) => (
              <button
                key={option.id}
                type="button"
                className={cn(
                  "rounded-sm px-2 py-1 text-xs font-medium",
                  tab === option.id
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => setTab(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div ref={chartRef} className="w-full">
          {width > 0 ? <PiUsageSeriesChart series={series} width={width} /> : null}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {figures.dimensions.map((dimension) => (
          <DimensionTable key={dimension.id} dimension={dimension} />
        ))}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">MAIN, unassigned</p>
        <p className="text-xs text-muted-foreground">
          MAIN work the producer could not bind to a task. It stays unassigned
          rather than being attributed to one.
        </p>
        <div className="rounded-md border border-border p-3 text-xs">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <RowTokens row={figures.mainUnassigned} />
            <span className="space-x-3">
              <span
                className={cn(
                  "tabular-nums",
                  figures.mainUnassigned.money.kind === "known"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {figures.mainUnassigned.money.text}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {figures.mainUnassigned.calls}{" "}
                {figures.mainUnassigned.calls === 1 ? "call" : "calls"}
              </span>
              <span className="text-muted-foreground/70">
                {figures.mainUnassigned.money.coverageText}
              </span>
            </span>
          </div>
        </div>
      </div>

      <CoveragePanel figures={figures} />

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>{figures.cost.label}</p>
        <p>{figures.quotaNote}</p>
        <p>{figures.modelIdentityNote}</p>
        <p>
          Window {figures.window.text} · recorded by {figures.producerAlias} (
          {figures.parserVersion}, revision {figures.producerRevision.slice(0, 12)})
        </p>
        <p>
          {figures.observation.finality}
          {figures.observation.latestRecordedAt
            ? ` · latest recorded ${figures.observation.latestRecordedAt}`
            : ""}
        </p>
      </div>
    </div>
  );
}

/**
 * The Pi lens as it appears on the page: one status line that keeps every
 * backend state distinguishable, then the figures when there are any.
 */
export function PiUsageSection() {
  const { reading, failed, loading, nowMs, reload } = usePiUsage();
  const view = useMemo(() => piUsageView(reading, nowMs), [reading, nowMs]);

  return (
    <Card className="shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5 pb-3">
        <div className="min-w-0">
          <CardTitle className="text-base">Firstmate Pi</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Task usage recorded by the Firstmate Pi harness, read from one machine
            as its own dataset. Pi is a harness, not a provider, and nothing here
            is added to BB's own totals or taken off a subscription.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void reload()}>
          Read again
        </Button>
      </CardHeader>
      <CardContent className="space-y-5 p-5 pt-0" aria-busy={loading && !reading}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={view.status.tone}>{view.status.label}</Badge>
          {view.status.retained ? <Badge tone="degraded">last known</Badge> : null}
          {view.status.degraded && !view.status.retained ? (
            <Badge tone="degraded">not current</Badge>
          ) : null}
          {view.verifiedIdleZero ? <Badge tone="ok">verified idle</Badge> : null}
          {view.status.recoveredFromFailure ? (
            <Badge tone="degraded">export recovered</Badge>
          ) : null}
          <span className="text-xs text-muted-foreground">{view.status.summary}</span>
        </div>
        <p className="text-xs text-muted-foreground">{view.status.detail}</p>
        {failed ? (
          <p className="text-xs text-destructive">
            The last ask for this source did not come back. The figures below, if
            any, are from an earlier read.
          </p>
        ) : null}
        {loading && !reading ? (
          <div className="space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : view.figures ? (
          <PiUsageFigures view={view} />
        ) : view.verifiedIdleZero ? (
          <p className="text-sm text-muted-foreground">
            The producer verified every declared source as idle for this window:
            no recorded calls.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            No figures to show. This is not a zero — nothing was read.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

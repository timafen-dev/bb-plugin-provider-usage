// What the Firstmate Pi section actually renders.
//
// `lib/pi-usage-view.ts` decides what the lens says; this file checks that the
// component really puts it on the page. The real `components/pi-usage.tsx`
// tree is rendered to static markup for the approved producer fixture and for
// degraded readings, and the assertions are about the text a reader would see:
// the producer's task keys, a `task · role` work item, a role, a requested
// model, the recorded USD beside an unknown one, the coverage status, and MAIN
// staying unassigned — plus the absence of anything private.
//
// The project's test runner strips types but cannot compile JSX, so the tree is
// loaded through jiti, which the bb toolchain already brings in. If it is not
// resolvable the whole file skips rather than failing: the presentation
// behaviour is covered either way by `pi-usage-view.test.mjs`, and a toolchain
// that moved should not look like a broken panel.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const require = createRequire(import.meta.url);

let hasJiti = true;
try {
  require.resolve("jiti");
} catch {
  hasJiti = false;
}

const fixtureText = await readFile(
  join(here, "fixtures", "pi-usage-snapshot.json"),
  "utf8",
);
const fixture = JSON.parse(fixtureText);
const GENERATED_MS = Date.parse(fixture.generated_at);

const loaded = hasJiti ? await load() : null;

async function load() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, {
    alias: {
      "@": repo,
      "@get-bb/plugin-sdk/app": join(here, "support", "plugin-sdk-app-stub.mjs"),
    },
    jsx: { runtime: "automatic" },
    moduleCache: false,
  });
  return {
    React: await jiti.import(require.resolve("react"), {}),
    server: await jiti.import(require.resolve("react-dom/server.node"), {}),
    section: await jiti.import(join(repo, "components", "pi-usage.tsx"), {}),
    contract: await jiti.import(join(repo, "lib", "pi-usage-contract.ts"), {}),
    view: await jiti.import(join(repo, "lib", "pi-usage-view.ts"), {}),
  };
}

const skip = loaded === null ? "jiti is not resolvable in this install" : false;

/** The figures as markup, for a reading of some snapshot text. */
function renderFigures(input = {}) {
  const nowMs = input.nowMs ?? GENERATED_MS;
  const reading = loaded.contract.readPiUsage({
    text: input.text === undefined ? fixtureText : input.text,
    nowMs,
    ...input.extra,
  });
  const view = loaded.view.piUsageView(reading, nowMs);
  return {
    view,
    html: loaded.server.renderToStaticMarkup(
      loaded.React.createElement(loaded.section.PiUsageFigures, { view }),
    ),
  };
}

test("the section renders the producer's own rows and figures", { skip }, () => {
  const { html } = renderFigures();

  // Tasks, with the title and the approved link the producer emitted.
  assert.match(html, /demo-task/);
  assert.match(html, /Synthetic producer contract/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/timafen-dev\/agentic-engineering\/issues\/496"/,
  );
  // Work items as `task · role`, roles, and the requested models.
  assert.match(html, /author/);
  assert.match(html, /supervisor/);
  assert.match(html, /claude-opus-5/);
  assert.match(html, /gpt-6\.1-sol/);
  // MAIN work with no task keeps its own place and stays unassigned.
  assert.match(html, /main_unassigned/);
  assert.match(html, /unassigned/);
  // Recorded money, and the coverage of it.
  assert.match(html, /\$0\.02/);
  assert.match(html, /1 of 3 calls priced/);
  // The window was only partly read, and the page says so.
  assert.match(html, /Partial/);
  assert.match(html, /part of the window not read|Token field gaps/);
});

test("the section labels its USD as an estimate, not an invoice", { skip }, () => {
  const { html } = renderFigures();
  assert.match(html, /API-equivalent/);
  assert.match(html, /not an invoice, a payment, or subscription quota/);
  // The producer's own disclaimer is shown: subscription remaining and reset
  // belong to the native subscriptions view, not to a Pi task.
  assert.match(html, /subscription remaining and reset come from/);
  assert.match(html, /not Pi task attribution/);
  // And the section itself claims no quota meter, percentage left or reset.
  assert.doesNotMatch(html, /% left|Resets|resets in|remaining quota/i);
});

test("an unpriced row renders as unknown rather than as zero spend", { skip }, () => {
  const { html } = renderFigures();
  // The dataset's one priced call shows an amount; the unpriced model row
  // shows an em dash with its own counter wording beside it.
  assert.match(html, /—/);
  assert.match(html, /0 of 2 calls priced · 2 missing a price/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("the token fields stay separate and reasoning is marked a subset", { skip }, () => {
  const { html } = renderFigures();
  assert.match(html, /Input/);
  assert.match(html, /Cache read/);
  assert.match(html, /Cache write/);
  assert.match(html, /Output/);
  assert.match(html, /reasoning/i);
  // The current-context cell reads unknown. A cache read is not the context,
  // so the cell must not be showing one.
  assert.match(html, /Current context<\/span><span[^>]*>unknown</);
  assert.match(html, /Cache read<\/span><span[^>]*>2\.2k</);
  // 280 + 2170 + 0 + 1080 tokens, with reasoning left out of the sum.
  assert.match(html, /3\.5k/);
});

test("a stale reading renders the same figures, aged, never as current", { skip }, () => {
  const fresh = renderFigures();
  const stale = renderFigures({ nowMs: GENERATED_MS + 10 * 60_000 });
  assert.equal(stale.view.status.status, "stale");
  assert.match(stale.html, /\$0\.02/);
  assert.match(stale.html, /10m/);
  // The figures are the producer's either way; only the age changed.
  assert.match(fresh.html, /demo-task/);
  assert.match(stale.html, /demo-task/);
});

test("a reading with no figures renders no figure markup at all", { skip }, () => {
  const missing = renderFigures({ text: null });
  assert.equal(missing.view.figures, null);
  assert.equal(missing.html, "");
});

test("the rendered markup carries no path, address or credential", { skip }, () => {
  for (const input of [{}, { text: "{]" }, { nowMs: GENERATED_MS - 60_000 }]) {
    const { html } = renderFigures(input);
    assert.doesNotMatch(html, /\/home\/|\/Users\/|\/root\/|~\//);
    assert.doesNotMatch(html, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    assert.doesNotMatch(html, /sk-[A-Za-z0-9-]{8,}|bearer |access_token|api[_-]?key/i);
    assert.doesNotMatch(html, /Traceback|SyntaxError/);
  }
});

test("the whole section renders before any answer has arrived", { skip }, () => {
  // A static render runs no effect, so this is the page's first paint: a state
  // line and a skeleton, and specifically not a zero.
  const html = loaded.server.renderToStaticMarkup(
    loaded.React.createElement(loaded.section.PiUsageSection, {}),
  );
  assert.match(html, /Firstmate Pi/);
  assert.match(html, /Not read yet/);
  assert.match(html, /not a provider/);
  assert.doesNotMatch(html, /\$0\.00/);
});

test("the chart draws one bar per recorded point, placed by time", { skip }, () => {
  const { view } = renderFigures();
  const live = view.figures.series.live;
  const width = 600;
  const html = loaded.server.renderToStaticMarkup(
    loaded.React.createElement(loaded.section.PiUsageSeriesChart, { series: live, width }),
  );

  const rects = [...html.matchAll(/<rect[^>]*x="([\d.]+)"[^>]*y="([\d.]+)"[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"/g)].map(
    (match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    }),
  );
  assert.equal(rects.length, live.points.length, "one bar per recorded bin");

  // Bars stay inside the plot, in the order the producer recorded them.
  for (const [index, rect] of rects.entries()) {
    assert.ok(rect.x >= 48 && rect.x + rect.width <= width - 10, "bar inside the plot");
    if (index > 0) assert.ok(rect.x > rects[index - 1].x, "bars in recorded order");
  }

  // The bar for the bin with the most recorded tokens is the tallest one, and
  // a bin is drawn at its own width, not a slot wide.
  const tallest = rects.indexOf(
    rects.reduce((best, rect) => (rect.height > best.height ? rect : best), rects[0]),
  );
  const heaviest = live.points.reduce(
    (best, point, index) =>
      point.tokens.recorded > live.points[best].tokens.recorded ? index : best,
    0,
  );
  assert.equal(tallest, heaviest);

  // The five minutes the producer recorded nothing in stay empty: the gap
  // between the first two bars is far wider than a bar.
  assert.ok(
    rects[1].x - (rects[0].x + rects[0].width) > rects[0].width * 10,
    "an unrecorded stretch must stay empty",
  );

  // And the readout says what a bin is, and what an empty one is not.
  assert.match(html, /not a streaming rate/);
  assert.match(html, /not a verified idle source/);
  assert.match(html, /10s bins/);
});

test("an hour chart keeps the offsets it was recorded with", { skip }, () => {
  const { view } = renderFigures();
  const html = loaded.server.renderToStaticMarkup(
    loaded.React.createElement(loaded.section.PiUsageSeriesChart, {
      series: view.figures.series.hours,
      width: 600,
    }),
  );
  assert.match(html, /Oct 1 22:00 \+00:00/);
});

test("a series with no recorded point says so instead of drawing a zero", { skip }, () => {
  const { view } = renderFigures();
  const empty = { ...view.figures.series.days, points: [], domain: null };
  const html = loaded.server.renderToStaticMarkup(
    loaded.React.createElement(loaded.section.PiUsageSeriesChart, {
      series: empty,
      width: 600,
    }),
  );
  assert.match(html, /No recorded points in this range/);
  assert.doesNotMatch(html, /<rect/);
});

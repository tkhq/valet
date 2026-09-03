---
name: artifact-design
description: Design guidance and a copy-paste component system for published artifact pages (artifact_publish, format html) — layout scaffold, stat tiles, tables, Chart.js/ECharts blocks, badges, comparisons — so pages from different sessions read as one product.
---

# Artifact Page Design

Load this skill before authoring an html artifact page. It carries the design
rules and a small component system. Pages built from it look consistent
across sessions without any server-side styling: every pattern is
self-contained and travels inside the page you publish.

## Ground rules

- **The shell gives you tokens — use them.** Every page gets `--artifact-bg`,
  `--artifact-fg`, `--artifact-muted`, `--artifact-line`,
  `--artifact-accent`, and a chart palette `--artifact-chart-1..8`, all
  light/dark aware. Style with `var(--artifact-*)` instead of hex values and
  the page adapts to dark mode for free.
- **Custom palette = define `--ds-*` in your own CSS.** The chart runtime
  prefers `--ds-chart-1..8`, `--ds-chart-text`, `--ds-chart-grid`,
  `--ds-font-body` over the defaults. Put them in one `:root` block at the
  top of your stylesheet (with a `prefers-color-scheme: dark` override when
  the brand needs one) and every chart and component follows.
- **Self-contained, always.** Inline all CSS and JS. Images as `data:` URIs;
  diagrams as inline SVG. Only cdn.jsdelivr.net and cdnjs.cloudflare.com
  load as scripts; Google Fonts is the only font host. There is no network:
  `fetch` is blocked, so bake the data into the page.
- **One typographic scale.** Body 15–17px, `line-height: 1.6`; headings tight
  (`line-height: 1.25`, negative letter-spacing on display sizes). Use a
  `.kicker` line (small caps, letter-spaced, accent color) above the h1 for
  context — source, ticket, date.
- **Numbers are monospace.** Metrics, costs, counts, and table numerics get
  `font-family: ui-monospace, monospace` and right alignment.
- **Density over chrome.** Prefer a bordered table or a tile row to cards in
  cards. One accent color; grays do the rest.
- If the user's org has a brand skill or a documented palette (CLAUDE.md,
  a design-tokens file), its values win over this skill's defaults.

## Page scaffold

Start every page from this frame:

```html
<style>
  :root {
    /* Optional brand palette — delete this block to use the defaults.
    --ds-chart-1: #4c48ff; --ds-chart-2: #f8a9d8; --ds-font-body: Inter, sans-serif; */
  }
  .wrap { max-width: 960px; margin: 0 auto; padding: 2.5rem 1.5rem 5rem; }
  .kicker { color: var(--artifact-accent); font-size: 12px; font-weight: 600;
    letter-spacing: .08em; text-transform: uppercase; }
  h1 { font-size: 2.4rem; line-height: 1.15; letter-spacing: -0.02em; margin: .3rem 0 .6rem; }
  .lede { font-size: 1.05rem; max-width: 65ch; }
  .lede b { font-weight: 650; }
  .meta { color: var(--artifact-muted); font-size: 12px; font-family: ui-monospace, monospace;
    display: flex; gap: 1.5rem; flex-wrap: wrap; margin-top: .8rem;
    padding-bottom: 1.2rem; border-bottom: 2px solid var(--artifact-fg); }
  section { margin-top: 2.5rem; }
  h2 { font-size: 13px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--artifact-muted); border-bottom: 1px solid var(--artifact-line);
    padding-bottom: .4rem; }
</style>
<div class="wrap">
  <p class="kicker">VALET EVALS · TKAI-213 · 11 RUNS</p>
  <h1>Four-Model Scorecard</h1>
  <p class="lede"><b>The one-sentence takeaway goes here.</b> Two more sentences of context at most.</p>
  <p class="meta"><span>2026-09-02</span><span>15 cases</span><span>PR #502–#529</span></p>
  <section>…components…</section>
</div>
```

## Components

Copy these wholesale; keep class names so follow-up edits can find them.

### Stat tiles (KPI row)

```html
<style>
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1px; background: var(--artifact-line); border: 1px solid var(--artifact-line);
    border-radius: 10px; overflow: hidden; }
  .tile { background: var(--artifact-bg); padding: .9rem 1rem; }
  .tile .label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
    color: var(--artifact-muted); }
  .tile .value { font-size: 1.6rem; font-weight: 650; font-family: ui-monospace, monospace; }
  .tile .delta { font-size: 12px; font-family: ui-monospace, monospace; }
  .up { color: var(--artifact-chart-1); } .down { color: var(--artifact-chart-5); }
</style>
<div class="tiles">
  <div class="tile"><div class="label">Passed</div><div class="value">15 / 15</div><div class="delta up">▲ from 6</div></div>
  <div class="tile"><div class="label">Suite cost</div><div class="value">$0.039</div><div class="delta up">8× cheaper</div></div>
</div>
```

### Data table

```html
<style>
  .data { width: 100%; border-collapse: collapse; font-size: 14px; }
  .data th { text-align: left; font-size: 11px; letter-spacing: .06em;
    text-transform: uppercase; color: var(--artifact-muted);
    border-bottom: 1px solid var(--artifact-line); padding: .5rem .7rem; }
  .data td { padding: .55rem .7rem; border-bottom: 1px solid var(--artifact-line); }
  .data td.num { font-family: ui-monospace, monospace; text-align: right; }
  .data td.good { color: var(--artifact-chart-1); font-weight: 600; }
  .data tr:hover td { background: color-mix(in srgb, var(--artifact-fg) 4%, transparent); }
</style>
```

Right-align every numeric column (`class="num"`). Never center body cells.

### Pills / badges

```html
<style>
  .pill { display: inline-block; border: 1px solid var(--artifact-line); border-radius: 999px;
    padding: .05rem .5rem; font-size: 11px; letter-spacing: .04em; color: var(--artifact-muted);
    font-family: ui-monospace, monospace; vertical-align: middle; }
  .pill.accent { color: var(--artifact-accent); border-color: var(--artifact-accent); }
</style>
<span class="pill accent">REASONING HIGH</span> <span class="pill">DEFAULT</span>
```

### Chart block (Chart.js)

```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<div style="position:relative;height:320px"><canvas id="passRate"></canvas></div>
<script>
  valetDS.applyChartTheme(Chart); // palette, fonts, grid from CSS variables
  new Chart(document.getElementById("passRate"), {
    type: "bar",
    data: {
      labels: ["Luna", "Opus 5", "Sonnet 5", "Haiku 4.5"],
      datasets: [{ label: "Passed (of 15)", data: [15, 15, 14, 10] }],
      // No colors set — applyChartTheme assigns the palette per dataset.
    },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } },
  });
</script>
```

Always wrap the canvas in a fixed-height positioned div, or the chart grows
unbounded. For heatmaps/sankey/treemaps use ECharts instead:
`<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>`
then `echarts.init(el, valetDS.echartsTheme())`.

### Side-by-side comparison

```html
<style>
  .compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; }
  .option { border: 1px solid var(--artifact-line); border-radius: 10px; padding: 1rem; }
  .option h3 { margin: 0 0 .3rem; font-size: 1rem; }
  .option .tradeoff { font-size: 12px; color: var(--artifact-muted); border-top: 1px dashed var(--artifact-line);
    margin-top: .8rem; padding-top: .6rem; }
</style>
```

Each option gets exactly one `.tradeoff` line. Three options beat five.

### Timeline / checklist (live-updating pages)

```html
<style>
  .timeline { list-style: none; padding: 0; margin: 0; }
  .timeline li { display: flex; gap: .6rem; padding: .4rem 0; font-size: 14px;
    border-bottom: 1px solid var(--artifact-line); }
  .timeline .t { font-family: ui-monospace, monospace; font-size: 12px;
    color: var(--artifact-muted); min-width: 4.5rem; }
  .timeline .done::before { content: "✓ "; color: var(--artifact-chart-1); }
  .timeline .todo::before { content: "○ "; color: var(--artifact-muted); }
</style>
```

Re-publish the same key after each step; the version history records the run.

## Anti-patterns

- Hex colors sprinkled through the CSS instead of the token variables — the
  page breaks in dark mode.
- Chart datasets with hand-picked colors next to themed ones — call
  `applyChartTheme` and let the palette assign.
- A wall of cards where a table carries the data better.
- Loading libraries for what CSS does (grids, transitions, tooltips via
  `title=`).
- `fetch()` anywhere — the page has no network; bake the data in.

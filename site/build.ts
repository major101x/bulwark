/**
 * Build the public snapshot page.
 *
 *   npm run site:build       # writes site/dist/index.html
 *
 * The dashboard proper (`npm run dashboard`) is a server, because it holds the
 * KeeperHub API key and must not hand it to a browser. That makes it
 * undeployable as-is and invisible to anyone who has not cloned the repo.
 *
 * So this bakes one fetch of the same state into a static page. Nothing here is
 * secret: wallet addresses, a contract address, position figures and
 * transaction hashes are all already public on chain. The API key stays on the
 * build machine.
 *
 * A static page taken at a moment in time must say so, prominently and with a
 * timestamp, or it is just a live dashboard that lies. The banner is not
 * decoration.
 *
 * ---
 *
 * On the design. An earlier revision was reviewed for looking machine
 * generated and scored badly, for good reasons that are worth recording so
 * they do not creep back:
 *
 *   - Violet-on-near-black with gradient headline text, a radial hero glow and
 *     a pill badge above the h1 is the default look of a generated landing
 *     page. All of it is gone. The accent is now achromatic, which leaves
 *     green/amber/red free to mean only what they mean everywhere else in this
 *     project: healthy, acting, failed.
 *   - Type is set in a system stack at four real weights. The previous version
 *     named Inter without ever loading it and asked for seven weights
 *     (520/560/580/650/660/680) that collapse to two on any fallback, so the
 *     tuning was invisible. Precision that cannot render is worse than none.
 *   - Numbers are sans with tabular figures; monospace is reserved for hashes
 *     and timestamps. Setting every figure in mono made a truncated tx hash
 *     carry the same weight as a health factor.
 *   - Monospace is for machine output only: hashes, timestamps, verbatim agent
 *     log lines, shell commands. It is deliberately NOT a label face. Uppercase
 *     letterspaced mono micro-labels over section headings and table columns
 *     are a signature of generated crypto pages, and using the second typeface
 *     as decoration is what made this one read that way.
 *   - Section rhythm and card widths vary by importance rather than repeating
 *     one template four times.
 */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getState, type DashboardState } from '../dashboard/data.ts';

const here = dirname(fileURLToPath(import.meta.url));

const REPO = 'https://github.com/major101x/bulwark';
const GUARDIAN_LOG = '0x06D8C09B5dbb9f9Bb96B7B20a351cdC5e16644D3';
const DEPLOY_TX = '0x62938be3d006d6a0757c827f3f463f0ea9043f8defb521e7d456b4287636ef7d';

/**
 * Runs shown on the public page. The dashboard shows more; here the rows are
 * near identical by design (the condition is false almost every time) and a
 * long column of them crowds out the sections that carry the argument.
 */
const SITE_RUN_LIMIT = 6;

/**
 * Self-hosted IBM Plex, copied out of the Fontsource packages at build time.
 *
 * Self-hosted rather than loaded from Google's CDN: one less third party in the
 * critical path, no request to an external host for a page whose whole point is
 * being verifiable, and nothing to break if that CDN is blocked. 106KB for five
 * weights, latin subset only.
 *
 * The previous stack said `system-ui`, which is honest but means the page has a
 * different typeface for every visitor: Ubuntu here, SF Pro on macOS, Segoe UI
 * on Windows. Measured on this machine, `system-ui` resolved to Ubuntu.
 */
const FONTS: Array<{ pkg: string; file: string; family: string; weight: number }> = [
  { pkg: 'ibm-plex-sans', file: 'ibm-plex-sans-latin-400-normal.woff2', family: 'IBM Plex Sans', weight: 400 },
  { pkg: 'ibm-plex-sans', file: 'ibm-plex-sans-latin-500-normal.woff2', family: 'IBM Plex Sans', weight: 500 },
  { pkg: 'ibm-plex-sans', file: 'ibm-plex-sans-latin-600-normal.woff2', family: 'IBM Plex Sans', weight: 600 },
  { pkg: 'ibm-plex-sans', file: 'ibm-plex-sans-latin-700-normal.woff2', family: 'IBM Plex Sans', weight: 700 },
  { pkg: 'ibm-plex-mono', file: 'ibm-plex-mono-latin-400-normal.woff2', family: 'IBM Plex Mono', weight: 400 },
];

const FONT_FACES = FONTS.map(
  (f) => `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};` +
    `font-display:swap;src:url("fonts/${f.file}") format("woff2");}`,
).join('\n');

/**
 * The Bulwark mark: a crenellated wall.
 *
 * A bulwark is a rampart, not a shield, and the generic security shield is the
 * most over-used glyph in the category. The merlons make it specific.
 *
 * Chosen by rendering the candidates at 96, 32, 21 and 16px and looking at
 * them, which killed two better-sounding ideas: a shield with a threshold slot
 * cut through it collapsed to an illegible blob below ~24px, and at small sizes
 * read as a minus sign, so the mark said "denied" rather than "defended".
 * Anything with interior detail has to survive a 16px browser tab first.
 */
const MARK_PATH =
  'M3.8 4.8H7.8V8.6H10V4.8H14V8.6H16.2V4.8H20.2V20.2H3.8V4.8Z';

/** Inline mark for the nav. currentColor, so it inherits the text ink. */
const NAV_MARK =
  '<svg class="mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  `<path fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}" fill="currentColor"/>` +
  '</svg>';

/**
 * Favicon: the same white mark on the page's own dark ground.
 *
 * On a transparent field a white glyph disappears against a light tab bar, and
 * roughly half of browsers run one, so the plate is doing real work.
 */
const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" fill="#0d0d10"/>' +
  `<g transform="translate(4 4)"><path fill-rule="evenodd" clip-rule="evenodd" d="${MARK_PATH}" fill="#ffffff"/></g>` +
  '</svg>';

const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}`;

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

const short = (h: string): string => (h ? `${esc(h.slice(0, 10))}…` : '');
const usd = (n: number): string => `$${Number(n).toFixed(2)}`;
const ethTx = (h: string): string => `https://etherscan.io/tx/${h}`;
const sepTx = (h: string): string => `https://sepolia.etherscan.io/tx/${h}`;
const sepAddr = (a: string): string => `https://sepolia.etherscan.io/address/${a}`;

function when(iso: string | number): string {
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function attestationRows(s: DashboardState): string {
  if (s.attestations.length === 0) {
    return '<tr><td colspan="7" class="dim">No attestations recorded.</td></tr>';
  }
  return s.attestations
    .map(
      (a) => `<tr>
      <td class="dim nowrap mono">${when(a.timestamp)}</td>
      <td><span class="pill ${a.action === 'HOLD' ? 'is-hold' : 'is-act'}">${esc(a.action)}</span></td>
      <td class="num">${a.healthFactor.toFixed(4)}</td>
      <td class="num">${usd(a.expectedLossUsd)}</td>
      <td class="num">${usd(a.rescueCostUsd)}</td>
      <td class="mono"><a class="link" href="${ethTx(a.txHash)}" target="_blank" rel="noopener">${short(a.txHash)}</a></td>
      <td class="mono">${
        a.remediationTxHash
          ? `<a class="link" href="${sepTx(a.remediationTxHash)}" target="_blank" rel="noopener">${short(a.remediationTxHash)}</a>`
          : '<span class="dim">none, held</span>'
      }</td>
    </tr>`,
    )
    .join('\n');
}

function runRows(s: DashboardState): string {
  if (s.workflowRuns.length === 0) {
    return '<tr><td colspan="5" class="dim">No workflow runs recorded.</td></tr>';
  }
  return s.workflowRuns
    .slice(0, SITE_RUN_LIMIT)
    .map(
      (r) => `<tr>
      <td class="dim nowrap mono">${when(r.startedAt)}</td>
      <td>${esc(r.triggerSource)}</td>
      <td><span class="status ${r.status === 'success' ? 'ok' : 'bad'}">${esc(r.status)}</span></td>
      <td class="num">${r.completedSteps}</td>
      <td class="mono">${
        r.txHashes.length > 0
          ? r.txHashes
              .map(
                (h) =>
                  `<a class="link" href="${sepTx(h)}" target="_blank" rel="noopener">${short(h)}</a>`,
              )
              .join(' ')
          : '<span class="dim">none, condition false</span>'
      }</td>
    </tr>`,
    )
    .join('\n');
}

const CSS = `
${FONT_FACES}

*,*::before,*::after { box-sizing:border-box; }

:root {
  /* ground and surfaces */
  --bg:#070709;
  --panel:#101014;
  --panel-2:#15151b;
  --rule:rgba(255,255,255,.07);      /* dividers, recede */
  --edge:rgba(255,255,255,.13);      /* container edges, legible */

  /* ink. The accent is achromatic on purpose: hue is reserved for meaning. */
  --text:#f4f4f6;
  --text-2:#dcdce6;
  --dim:#8f8fa0;                     /* 6.33:1 on --bg */
  --dimmer:#7e7e8c;                  /* 5.03:1 on --bg, was #63636f at 3.4:1 */
  --on-ink:#0a0a0c;

  /* meaning, desaturated off the framework defaults */
  --ok:#4fb47a;
  --warn:#c9993f;
  --warn-ink:#e7dcc4;
  --bad:#d0645f;

  --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

  /* type scale */
  --t-xs:13px; --t-sm:14px; --t-base:15px; --t-md:17px; --t-lg:21px;

  /* 4px spacing grid */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px;
  --s6:32px; --s7:48px; --s8:64px; --s9:96px;

  /* Squared throughout: no radius anywhere, including buttons and pills. */
  --r-sm:0; --r:0; --r-lg:0; --r-pill:0;
}

html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior:auto; }
  * { transition:none !important; }
}

body {
  margin:0; background:var(--bg); color:var(--text);
  font-family:var(--sans); font-size:var(--t-md); line-height:1.6;
  font-weight:400; -webkit-font-smoothing:antialiased;
}

a { color:inherit; text-decoration:none; }
:where(a,button):focus-visible { outline:2px solid var(--text); outline-offset:3px; }

/* Links in prose are underlined, not merely tinted. With an achromatic accent
   a colour-only link would be indistinguishable from the text around it. */
.link {
  text-decoration:underline; text-decoration-thickness:1px;
  text-underline-offset:.18em; text-decoration-color:rgba(255,255,255,.32);
}
.link:hover { text-decoration-color:var(--text); }

/* Family only. Sizing mono in em is a trap: inside a table cell the em
   resolves against the inherited body size, not the cell's, so the hashes came
   out larger than the figures next to them. Sizes are set explicitly, one step
   below the sans, because Plex Mono reads optically larger at equal px. */
.mono { font-family:var(--mono); letter-spacing:-.01em; }
td.mono, th.mono { font-size:14px; }
.dim { color:var(--dim); }
.nowrap { white-space:nowrap; }

/* Figures are sans with tabular lining, so columns align without monospace
   flattening a health factor and a transaction hash to the same weight. */
.num, .fig {
  text-align:right; font-weight:500;
  font-variant-numeric:tabular-nums;
  font-feature-settings:"tnum" 1;
}
.fig { text-align:inherit; }

.wrap { width:100%; max-width:1120px; margin:0 auto; padding:0 var(--s5); }

/* ---------- nav ---------- */
nav {
  position:sticky; top:0; z-index:50;
  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
  background:rgba(7,7,9,.78); border-bottom:1px solid var(--rule);
}
.nav-in { display:flex; align-items:center; gap:var(--s5); height:60px; }
/* the auto margin lives on an element that is never hidden, so the mobile
   layout does not collapse when the links go away */
.brand {
  margin-right:auto; display:inline-flex; align-items:center; gap:9px;
  font-weight:600; letter-spacing:-.02em; font-size:var(--t-md); color:var(--text);
}
.mark { width:21px; height:21px; flex:none; display:block; }
.nav-links { display:flex; gap:var(--s5); font-size:var(--t-base); color:var(--dim); }
.nav-links a:hover { color:var(--text); }
@media (max-width:820px){ .nav-links { display:none; } }

.btn {
  display:inline-flex; align-items:center; justify-content:center;
  padding:10px 18px; border-radius:var(--r-pill);
  font-size:var(--t-base); font-weight:500; white-space:nowrap;
  border:1px solid transparent;
  transition:background-color .16s ease, border-color .16s ease, color .16s ease;
}
.btn-primary { background:var(--text); color:var(--on-ink); }
.btn-primary:hover { background:#fff; }
.btn-ghost { border-color:var(--edge); color:var(--text); }
.btn-ghost:hover { border-color:var(--dim); background:rgba(255,255,255,.04); }

/* ---------- hero ---------- */
/* Left aligned to the same gutter as the nav brand and every table below it.
   No glow, no gradient fill, no badge. */
.hero { padding:var(--s9) 0 var(--s7); }
h1 {
  font-size:clamp(40px,3.5vw + 26px,64px); line-height:1.05;
  letter-spacing:-.03em; font-weight:700;
  margin:0 0 var(--s5); max-width:22ch; text-wrap:balance;
}
.lede {
  font-size:clamp(17px,.5vw + 15px,20px); color:var(--dim);
  max-width:56ch; margin:0 0 var(--s6); text-wrap:pretty;
}
.cta { display:flex; gap:var(--s3); flex-wrap:wrap; }

/* ---------- stats ---------- */
/* Hairline separated, no card fill: one figure carries the argument and three
   are footnotes, so they are not four identical boxes. */
.stats {
  display:grid; grid-template-columns:1.7fr 1fr 1fr 1fr;
  border-top:1px solid var(--rule); padding-top:var(--s5);
}
.stat { padding:0 var(--s5); border-left:1px solid var(--rule); }
.stat:first-child { padding-left:0; border-left:none; }
.stat .v {
  font-size:clamp(28px,1vw + 24px,34px); font-weight:700; letter-spacing:-.02em;
  line-height:1.05; font-variant-numeric:tabular-nums;
}
.stat.lead .v { font-size:clamp(40px,2vw + 30px,52px); letter-spacing:-.03em; }
.stat .k { color:var(--dim); font-size:var(--t-base); margin-top:var(--s2); text-wrap:pretty; }
@media (max-width:820px){
  .stats { grid-template-columns:1fr 1fr; gap:var(--s5) 0; }
  .stat:nth-child(3) { padding-left:0; border-left:none; }
}
@media (max-width:480px){
  .stats { grid-template-columns:1fr; }
  .stat { padding-left:0; border-left:none; }
}

/* ---------- sections ---------- */
/* Rhythm varies with what the section is for: the argument gets room, the
   appendix gets less. */
section { padding-top:var(--s9); }
#position, #trail { padding-top:var(--s8); }
#runs { padding-top:var(--s7); }

.sec-head { border-top:1px solid var(--rule); padding-top:var(--s5); margin-bottom:var(--s6); }
h2 {
  font-size:clamp(26px,1.5vw + 20px,36px); line-height:1.15; letter-spacing:-.03em;
  font-weight:700; margin:0 0 var(--s3); max-width:26ch; text-wrap:balance;
}
.sub { color:var(--dim); font-size:var(--t-md); max-width:62ch; margin:0; text-wrap:pretty; }

/* ---------- snapshot notice ---------- */
.notice {
  display:flex; gap:var(--s3); align-items:flex-start;
  border:1px solid rgba(201,153,63,.32); background:rgba(201,153,63,.07);
  border-radius:var(--r); padding:var(--s4) var(--s4);
  margin-top:var(--s6); font-size:var(--t-base); color:var(--warn-ink);
}
.notice .ico { flex:none; width:18px; height:18px; margin-top:2px; color:var(--warn); }
.notice b { color:var(--warn); font-weight:600; }
.notice code, footer code, .note code {
  font-family:var(--mono); font-size:.9em;
  background:rgba(255,255,255,.07); padding:1px 6px; border-radius:var(--r-sm);
}

/* ---------- cards ---------- */
/* Widths track importance rather than four equal columns. */
.cards { display:grid; grid-template-columns:1.4fr 1fr 1fr 1fr; gap:var(--s3); }
@media (max-width:900px){ .cards { grid-template-columns:1fr 1fr; } }
@media (max-width:520px){ .cards { grid-template-columns:1fr; } }
.card {
  border:1px solid var(--edge); border-radius:var(--r); padding:var(--s4);
  background:var(--panel);
}
.card.feature { display:flex; flex-direction:column; justify-content:center; }
.card h3 {
  font-size:var(--t-xs); font-weight:600;
  text-transform:uppercase; letter-spacing:.07em; color:var(--dim);
  margin:0 0 var(--s3);
}
.card .hero-num {
  font-size:34px; font-weight:700; letter-spacing:-.02em; line-height:1;
  font-variant-numeric:tabular-nums;
}
.card .row { display:flex; justify-content:space-between; gap:var(--s2); padding:2px 0; font-size:var(--t-base); }
.card .row span { color:var(--dim); }
.card .row b { font-weight:600; font-variant-numeric:tabular-nums; }

.pill { display:inline-block; padding:3px 10px; border-radius:var(--r-pill); font-size:var(--t-xs); font-weight:600; }
.is-hold { background:rgba(79,180,122,.15); color:var(--ok); }
.is-act { background:rgba(201,153,63,.16); color:var(--warn); }
.tier-IDLE{background:rgba(79,180,122,.15);color:var(--ok)}
.tier-WATCH{background:rgba(255,255,255,.09);color:#c8c8d0}
.tier-ARMED{background:rgba(201,153,63,.16);color:var(--warn)}
.tier-CRITICAL{background:rgba(208,100,95,.16);color:var(--bad)}
.status.ok { color:var(--ok); }
.status.bad { color:var(--bad); }

.rationale {
  margin-top:var(--s4); border:1px solid var(--edge); border-left:3px solid var(--text);
  border-radius:var(--r-sm); background:var(--panel); padding:var(--s4) var(--s5);
  font-family:var(--mono); font-size:var(--t-base); line-height:1.7;
  white-space:pre-wrap; word-break:break-word; color:var(--text-2);
}

/* ---------- tables ---------- */
/* Data containers get a tighter radius than cards: they are documents, not
   objects. overflow lives on the inner element so the two axes cannot fight. */
.tbl { border:1px solid var(--edge); border-radius:var(--r-sm); overflow:clip; background:var(--panel); }
.tbl-scroll {
  overflow-x:auto; overflow-y:hidden;
  background:
    linear-gradient(to right, var(--panel) 30%, transparent) left / 40px 100% no-repeat local,
    linear-gradient(to left,  var(--panel) 30%, transparent) right / 40px 100% no-repeat local,
    radial-gradient(farthest-side at 0 50%, rgba(0,0,0,.45), transparent) left / 14px 100% no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, rgba(0,0,0,.45), transparent) right / 14px 100% no-repeat scroll;
}
table { border-collapse:collapse; width:100%; min-width:680px; }
th,td { text-align:left; padding:12px var(--s4); border-bottom:1px solid var(--rule); font-size:var(--t-base); line-height:1.45; }
/* The header band sits on its own ground so the eye separates the labels
   from the data without needing a heavier rule between them. */
thead { background:var(--panel-2); }
th {
  color:var(--dim); font-weight:600; font-size:var(--t-xs);
  letter-spacing:.07em; text-transform:uppercase; white-space:nowrap;
  border-bottom:1px solid var(--edge);
}
th.num { text-align:right; }
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover td { background:rgba(255,255,255,.022); }
.note { color:var(--dim); font-size:var(--t-base); margin:var(--s4) 0 0; max-width:74ch; text-wrap:pretty; }

.score td:first-child { font-weight:500; }
.score .win { color:var(--ok); font-weight:600; font-variant-numeric:tabular-nums; }
.score .lose { color:var(--bad); font-variant-numeric:tabular-nums; }
.score .flat { color:var(--dim); font-variant-numeric:tabular-nums; }

/* ---------- closing ---------- */
.cta-panel {
  margin-top:var(--s9); border:1px solid var(--edge); border-radius:var(--r);
  background:var(--panel); padding:var(--s7) var(--s6);
  display:flex; gap:var(--s6); align-items:center; justify-content:space-between; flex-wrap:wrap;
}
.cta-panel h2 { margin:0 0 var(--s2); font-size:clamp(23px,1vw + 19px,30px); }
.cta-panel p { margin:0; color:var(--dim); max-width:50ch; font-size:var(--t-md); }

footer { margin-top:var(--s8); border-top:1px solid var(--rule); padding:var(--s6) 0 var(--s7); color:var(--dim); font-size:var(--t-sm); }
.foot-in { display:flex; gap:var(--s5); justify-content:space-between; flex-wrap:wrap; align-items:center; }

/* sticky nav must not park section headings underneath itself */
section, #top { scroll-margin-top:76px; }

@media (max-width:640px){
  .cta .btn { flex:1 1 100%; }
}
`;

function render(s: DashboardState): string {
  const p = s.position;
  const d = s.decision;
  const hf = p && p.healthFactor !== null ? p.healthFactor.toFixed(4) : '∞';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bulwark · liquidation defense that knows when not to act</title>
<meta name="description" content="A liquidation-defense keeper that executes onchain through KeeperHub, prices every rescue against the loss it prevents, and attests every decision to Ethereum mainnet." />
<meta name="color-scheme" content="dark" />
<link rel="icon" href="${FAVICON_HREF}" />
<style>${CSS}</style>
</head>
<body>

<nav>
  <div class="wrap nav-in">
    <a class="brand" href="#top">${NAV_MARK}<span>Bulwark</span></a>
    <div class="nav-links">
      <a href="#reliability">Reliability</a>
      <a href="#position">Position</a>
      <a href="#trail">Decision trail</a>
      <a href="${REPO}/tree/main/starter-template">Starter template</a>
    </div>
    <a class="btn btn-primary" href="${REPO}">View source</a>
  </div>
</nav>

<header class="hero" id="top">
  <div class="wrap">
    <h1>Liquidation defense that knows when not to act.</h1>
    <p class="lede">
      A keeper that executes onchain through KeeperHub, prices every rescue against the
      loss it would actually prevent, and attests the decision to Ethereum mainnet.
      Holds included, because a keeper that only records its successes is not an audit trail.
    </p>
    <div class="cta">
      <a class="btn btn-primary" href="${REPO}">Read the source</a>
      <a class="btn btn-ghost" href="https://etherscan.io/address/${GUARDIAN_LOG}">GuardianLog on mainnet</a>
    </div>
  </div>
</header>

<div class="wrap">
  <div class="stats">
    <div class="stat lead">
      <div class="v">4/4</div>
      <div class="k">landed under gas underpricing, against 0/4 for a naive baseline</div>
    </div>
    <div class="stat">
      <div class="v">$0</div>
      <div class="k">capital used. Mainnet contract deployed on sponsored gas</div>
    </div>
    <div class="stat">
      <div class="v">${s.totalWorkflowRuns}</div>
      <div class="k">autonomous workflow runs, firing every 50 blocks</div>
    </div>
    <div class="stat">
      <div class="v">${s.attestations.length}</div>
      <div class="k">decisions attested on Ethereum mainnet</div>
    </div>
  </div>

  <div class="notice">
    <svg class="ico" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 4a1 1 0 011 1v4a1 1 0 11-2 0V7a1 1 0 011-1zm0 8.5a1.15 1.15 0 110-2.3 1.15 1.15 0 010 2.3z"/></svg>
    <div>
      <b>This is a static snapshot</b>, taken ${when(s.fetchedAt)}. It does not update.
      The live dashboard is a local server (<code>npm run dashboard</code>): it reads a
      KeeperHub API key, so it cannot be served publicly without handing that key to the
      browser. Every row below links to a block explorer, where the record is live and
      verifiable independently of this page.
    </div>
  </div>
</div>

<section id="reliability">
  <div class="wrap">
    <div class="sec-head">
      <h2>Landing the transaction is the hard part.</h2>
      <p class="sub">
        Spotting a position in danger is easy. Getting the rescue mined at 3am during a
        gas spike is not. So we measured it: identical workloads, same unusable gas
        price, KeeperHub against plain ethers.js.
      </p>
    </div>
    <div class="tbl"><div class="tbl-scroll">
      <table class="score">
        <thead><tr>
          <th>Scenario</th><th>KeeperHub</th><th>ethers (blind gas limit)</th><th>ethers (default)</th>
        </tr></thead>
        <tbody>
          <tr><td>Gas underpricing (0.05 gwei vs ~0.98 market)</td><td class="win">4/4 landed</td><td class="lose">0/4, all stuck</td><td class="flat">no data</td></tr>
          <tr><td>Congestion (4 concurrent from one wallet)</td><td class="win">4/4 landed</td><td class="flat">1/4</td><td class="flat">2/4</td></tr>
          <tr><td>Revert</td><td class="flat">all refused</td><td class="flat">all refused</td><td class="flat">all refused</td></tr>
        </tbody>
      </table>
    </div></div>
    <p class="note">
      Sepolia, 2026-08-02, four trials per cell. One cell reads "no data" rather than 0%
      because those trials failed on our own network, and charging that to a backend
      would measure our connection instead of the thing under test. Revert shows no
      difference and is reported as such rather than dressed up.
      <a class="link" href="${REPO}/blob/main/chaos/RESULTS.md">Method and raw data</a>.
    </p>
  </div>
</section>

<section id="position">
  <div class="wrap">
    <div class="sec-head">
      <h2>The position, and what the agent decided.</h2>
    </div>
    <div class="cards">
      <div class="card feature">
        <h3>Health factor</h3>
        <div class="hero-num">${hf}</div>
        <div style="margin-top:12px"><span class="pill tier-${p ? esc(p.tier) : 'IDLE'}">${p ? esc(p.tier) : 'unknown'}</span></div>
      </div>
      <div class="card">
        <h3>Position</h3>
        <div class="row"><span>collateral</span><b>${p ? usd(p.collateralUsd) : '?'}</b></div>
        <div class="row"><span>debt</span><b>${p ? usd(p.debtUsd) : '?'}</b></div>
        <div class="row"><span>liq. threshold</span><b>${p ? (p.liquidationThreshold * 100).toFixed(0) + '%' : '?'}</b></div>
      </div>
      <div class="card">
        <h3>Keeper ammunition</h3>
        <div class="row"><span>USDC</span><b>${s.keeper ? esc(s.keeper.usdc) : '?'}</b></div>
        <div class="row"><span>LINK</span><b>${s.keeper ? esc(s.keeper.link) : '?'}</b></div>
        <div class="row"><span style="font-size:13px">spent for the position</span></div>
      </div>
      <div class="card">
        <h3>Economics</h3>
        <div class="row"><span>P(liquidation)</span><b>${d ? (d.liquidationProbability * 100).toFixed(2) + '%' : '?'}</b></div>
        <div class="row"><span>expected loss</span><b>${d ? usd(d.expectedLossUsd) : '?'}</b></div>
        <div class="row"><span>rescue cost</span><b>${d ? usd(d.rescueCostUsd) : '?'}</b></div>
      </div>
    </div>
    ${d ? `<div class="rationale">${esc(d.rationale)}</div>` : ''}
  </div>
</section>

<section id="trail">
  <div class="wrap">
    <div class="sec-head">
      <h2>Every decision, on Ethereum mainnet.</h2>
      <p class="sub">
        Holds are attested as well as rescues. The declined rescues are the interesting
        judgment calls, and a log that omits them proves nothing.
      </p>
    </div>
    <div class="tbl"><div class="tbl-scroll">
      <table>
        <thead><tr>
          <th>When</th><th>Action</th><th class="num">HF</th><th class="num">Expected loss</th>
          <th class="num">Rescue cost</th><th>Attestation</th><th>Remediation</th>
        </tr></thead>
        <tbody>
${attestationRows(s)}
        </tbody>
      </table>
    </div></div>
    <p class="note">
      Contract <a class="link mono" href="https://etherscan.io/address/${GUARDIAN_LOG}">${esc(GUARDIAN_LOG)}</a>,
      deployed through a CREATE3 factory on sponsored gas
      (<a class="link" href="${ethTx(DEPLOY_TX)}">deployment</a>).
      Storage-free by design, so an attestation costs only the base transaction plus log data.
    </p>
  </div>
</section>

<section id="runs">
  <div class="wrap">
    <div class="sec-head">
      <h2>The watcher, still firing.</h2>
      <p class="sub">
        A KeeperHub workflow owns the CRITICAL tier server-side, so the position stays
        defended whether or not anything of ours is running. Showing the
        ${Math.min(SITE_RUN_LIMIT, s.workflowRuns.length)} most recent of ${s.totalWorkflowRuns}.
      </p>
    </div>
    <div class="tbl"><div class="tbl-scroll">
      <table>
        <thead><tr>
          <th>Started</th><th>Trigger</th><th>Status</th><th class="num">Steps</th><th>Transactions</th>
        </tr></thead>
        <tbody>
${runRows(s)}
        </tbody>
      </table>
    </div></div>
    <p class="note">
      Most runs do nothing, which is the correct outcome: the condition evaluates false
      and the workflow stops after three nodes without broadcasting anything.
    </p>
  </div>
</section>

<div class="wrap">
  <div class="cta-panel">
    <div>
      <h2>Read it, or run it.</h2>
      <p>
        The whole thing is one repository: the risk model, the chaos harness, the
        workflows, and a starter template that lands your first KeeperHub transaction
        with nothing but an API key.
      </p>
    </div>
    <div class="cta">
      <a class="btn btn-primary" href="${REPO}">View source</a>
      <a class="btn btn-ghost" href="${REPO}/tree/main/starter-template">Starter template</a>
    </div>
  </div>
</div>

<footer>
  <div class="wrap foot-in">
    <div>
      Built for the KeeperHub <em>Agents Onchain</em> hackathon.<br />
      Watching <a class="link mono" href="${sepAddr(s.config.watchedWallet)}" target="_blank" rel="noopener">${esc(s.config.watchedWallet)}</a> on Sepolia.
    </div>
  </div>
</footer>

</body>
</html>
`;
}

const state = await getState();

if (state.warnings.length > 0) {
  console.error('Warnings while gathering state:');
  for (const w of state.warnings) console.error(`  - ${w}`);
}

/**
 * Refuse to publish a page missing any of the three things it exists to show.
 *
 * Each is a live network call made at build time, and all three have now failed
 * transiently at least once while building this page. A failure produces an
 * empty table or a row of "?" cards, which does not read as "the build machine
 * could not reach an RPC". It reads as "this agent has never done anything",
 * which is the opposite of what the page is claiming.
 *
 * Publishing nothing is recoverable by running the build again. Publishing a
 * page that quietly understates the work is not, because nobody looking at it
 * knows to doubt it.
 */
const missing: string[] = [];
if (state.attestations.length === 0) {
  missing.push('no attestations, the decision trail would be empty (check the ledger)');
}
if (state.position === null || state.decision === null) {
  missing.push('no position read, the cards would publish "?" (Sepolia RPC)');
}
if (state.workflowRuns.length === 0) {
  missing.push('no workflow runs, the execution trail would read "0 of 0" (KeeperHub API)');
}

if (missing.length > 0) {
  console.error('\nRefusing to build:');
  for (const m of missing) console.error(`  - ${m}`);
  console.error('\nUsually transient. Run it again.');
  process.exit(1);
}

const outDir = join(here, 'dist');
mkdirSync(outDir, { recursive: true });

const fontDir = join(outDir, 'fonts');
mkdirSync(fontDir, { recursive: true });
for (const f of FONTS) {
  copyFileSync(
    join(here, '..', 'node_modules', '@fontsource', f.pkg, 'files', f.file),
    join(fontDir, f.file),
  );
}
// OFL requires the licence travel with the fonts.
copyFileSync(
  join(here, '..', 'node_modules', '@fontsource', 'ibm-plex-sans', 'LICENSE'),
  join(fontDir, 'LICENSE-IBM-Plex.txt'),
);
writeFileSync(join(outDir, 'index.html'), render(state), 'utf8');

console.log(`Wrote site/dist/index.html`);
console.log(`  ${FONTS.length} self-hosted font files`);
console.log(`  ${state.attestations.length} attestations`);
console.log(`  ${state.workflowRuns.length} of ${state.totalWorkflowRuns} workflow runs`);
console.log(`  position HF ${state.position?.healthFactor?.toFixed(4) ?? 'n/a'}`);

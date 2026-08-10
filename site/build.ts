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
 * On the design: prose is set in a sans face and only *data* is monospaced.
 * Setting everything in mono reads as a terminal dump rather than a page, and
 * it flattens the hierarchy between a claim and the evidence for it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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
      <td class="num mono">${a.healthFactor.toFixed(4)}</td>
      <td class="num mono">${usd(a.expectedLossUsd)}</td>
      <td class="num mono">${usd(a.rescueCostUsd)}</td>
      <td class="mono"><a href="${ethTx(a.txHash)}" target="_blank" rel="noopener">${short(a.txHash)}</a></td>
      <td class="mono">${
        a.remediationTxHash
          ? `<a href="${sepTx(a.remediationTxHash)}" target="_blank" rel="noopener">${short(a.remediationTxHash)}</a>`
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
      <td class="num mono">${r.completedSteps}</td>
      <td class="mono">${
        r.txHashes.length > 0
          ? r.txHashes
              .map(
                (h) =>
                  `<a href="${sepTx(h)}" target="_blank" rel="noopener">${short(h)}</a>`,
              )
              .join(' ')
          : '<span class="dim">none, condition false</span>'
      }</td>
    </tr>`,
    )
    .join('\n');
}

const CSS = `
*,*::before,*::after { box-sizing:border-box; }

:root {
  --bg:#070709;
  --bg-2:#0b0b0f;
  --panel:#101014;
  --panel-2:#15151b;
  --line:rgba(255,255,255,.07);
  --line-2:rgba(255,255,255,.12);
  --text:#f4f4f6;
  --dim:#8f8fa0;
  --dimmer:#63636f;
  --accent:#8b7cff;
  --accent-soft:rgba(139,124,255,.14);
  --ok:#4ade80;
  --warn:#fbbf24;
  --bad:#f87171;
  --sans:"Inter","SF Pro Display",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --r:14px;
}

html { -webkit-text-size-adjust:100%; }
body {
  margin:0; background:var(--bg); color:var(--text);
  font-family:var(--sans); font-size:16px; line-height:1.6;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
  overflow-x:hidden;
}
a { color:inherit; text-decoration:none; }
.mono { font-family:var(--mono); font-size:.86em; letter-spacing:-.01em; }
.dim { color:var(--dim); }
.num { text-align:right; }
.nowrap { white-space:nowrap; }

.wrap { width:100%; max-width:1120px; margin:0 auto; padding:0 24px; }

/* ---------- nav ---------- */
nav {
  position:sticky; top:0; z-index:50;
  backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
  background:rgba(7,7,9,.72); border-bottom:1px solid var(--line);
}
.nav-in { display:flex; align-items:center; gap:28px; height:62px; }
.brand { display:flex; align-items:center; gap:9px; font-weight:650; letter-spacing:-.02em; font-size:16.5px; }
.brand-mark {
  width:22px; height:22px; border-radius:6px; flex:none;
  background:linear-gradient(145deg,var(--accent),#4c3fd6);
  box-shadow:0 0 16px rgba(139,124,255,.5);
}
.nav-links { display:flex; gap:22px; margin-left:auto; font-size:14px; color:var(--dim); }
.nav-links a:hover { color:var(--text); }
.btn {
  display:inline-flex; align-items:center; gap:7px;
  padding:9px 17px; border-radius:999px; font-size:14px; font-weight:560;
  border:1px solid transparent; white-space:nowrap; transition:.16s ease;
}
.btn-primary { background:var(--accent); color:#0a0a12; }
.btn-primary:hover { background:#a294ff; transform:translateY(-1px); }
.btn-ghost { border-color:var(--line-2); color:var(--text); }
.btn-ghost:hover { border-color:var(--dim); background:rgba(255,255,255,.04); }
@media (max-width:760px){ .nav-links { display:none; } }

/* ---------- hero ---------- */
.hero { position:relative; padding:96px 0 76px; text-align:center; overflow:hidden; }
.hero::before {
  content:""; position:absolute; left:50%; top:-340px; transform:translateX(-50%);
  width:1100px; height:720px; pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(139,124,255,.20), rgba(139,124,255,.05) 42%, transparent 68%);
}
.hero > * { position:relative; }
.badge {
  display:inline-flex; align-items:center; gap:8px;
  padding:6px 14px 6px 8px; border-radius:999px; font-size:13px; color:var(--dim);
  border:1px solid var(--line-2); background:rgba(255,255,255,.03); margin-bottom:26px;
}
.badge .dot { width:6px; height:6px; border-radius:50%; background:var(--ok); box-shadow:0 0 9px var(--ok); }
h1 {
  font-size:clamp(38px,6.2vw,66px); line-height:1.04; letter-spacing:-.038em;
  font-weight:680; margin:0 auto 22px; max-width:15ch;
}
h1 .grad {
  background:linear-gradient(100deg,var(--accent),#c9c2ff 60%,#7de0c0);
  -webkit-background-clip:text; background-clip:text; color:transparent;
}
.lede { font-size:clamp(16px,1.9vw,19px); color:var(--dim); max-width:62ch; margin:0 auto 34px; }
.cta { display:flex; gap:12px; justify-content:center; flex-wrap:wrap; }

/* ---------- stats ---------- */
.stats { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:12px 0 8px; }
@media (max-width:860px){ .stats { grid-template-columns:repeat(2,1fr); } }
.stat {
  border:1px solid var(--line); border-radius:var(--r); padding:22px 20px;
  background:linear-gradient(180deg,var(--panel-2),var(--panel));
}
.stat .v { font-size:clamp(26px,3.4vw,34px); font-weight:680; letter-spacing:-.035em; line-height:1.1; }
.stat .k { color:var(--dim); font-size:13.5px; margin-top:7px; }
.stat.accent { border-color:rgba(139,124,255,.35); background:linear-gradient(180deg,rgba(139,124,255,.16),rgba(139,124,255,.04)); }
.stat.accent .v { color:#cfc7ff; }

/* ---------- sections ---------- */
section { padding:82px 0 0; }
.eyebrow {
  display:inline-block; padding:5px 13px; border-radius:999px; font-size:12.5px;
  color:var(--accent); background:var(--accent-soft); border:1px solid rgba(139,124,255,.25);
  margin-bottom:16px;
}
h2 { font-size:clamp(27px,3.9vw,40px); line-height:1.14; letter-spacing:-.032em; font-weight:660; margin:0 0 14px; max-width:26ch; text-wrap:balance; }
.sec-head { margin-bottom:34px; }
.sec-head.center { text-align:center; }
.sec-head.center h2, .sec-head.center .sub { margin-left:auto; margin-right:auto; }
.sub { color:var(--dim); font-size:16px; max-width:64ch; margin:0; }

/* ---------- snapshot notice ---------- */
.notice {
  display:flex; gap:14px; align-items:flex-start;
  border:1px solid rgba(251,191,36,.28); background:rgba(251,191,36,.07);
  border-radius:var(--r); padding:16px 18px; margin-top:34px; font-size:14.5px; color:#e7dcc4;
}
.notice .ico { flex:none; width:20px; height:20px; margin-top:1px; color:var(--warn); }
.notice b { color:var(--warn); font-weight:600; }
.notice code { font-family:var(--mono); font-size:.88em; background:rgba(255,255,255,.07); padding:1px 6px; border-radius:5px; }

/* ---------- cards ---------- */
.cards { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; }
@media (max-width:900px){ .cards { grid-template-columns:repeat(2,1fr); } }
@media (max-width:520px){ .cards { grid-template-columns:1fr; } }
.card {
  border:1px solid var(--line); border-radius:var(--r); padding:20px;
  background:linear-gradient(180deg,var(--panel-2),var(--panel));
}
.card h3 { font-size:12.5px; color:var(--dim); font-weight:560; margin:0 0 12px; letter-spacing:.01em; }
.card .hero-num { font-size:38px; font-weight:680; letter-spacing:-.04em; line-height:1; font-family:var(--mono); }
.card .row { display:flex; justify-content:space-between; gap:10px; padding:3px 0; font-size:14.5px; }
.card .row b { font-family:var(--mono); font-weight:560; }

.pill { display:inline-block; padding:3px 11px; border-radius:999px; font-size:12px; font-weight:580; }
.is-hold { background:rgba(74,222,128,.14); color:var(--ok); }
.is-act { background:rgba(251,191,36,.15); color:var(--warn); }
.tier-IDLE{background:rgba(74,222,128,.14);color:var(--ok)}
.tier-WATCH{background:rgba(139,124,255,.16);color:#b0a5ff}
.tier-ARMED{background:rgba(251,191,36,.15);color:var(--warn)}
.tier-CRITICAL{background:rgba(248,113,113,.15);color:var(--bad)}
.status.ok { color:var(--ok); }
.status.bad { color:var(--bad); }

.rationale {
  margin-top:16px; border:1px solid var(--line); border-left:3px solid var(--accent);
  border-radius:12px; background:var(--panel); padding:18px 20px;
  font-family:var(--mono); font-size:14.5px; line-height:1.78;
  white-space:pre-wrap; word-break:break-word; color:#dcdce6;
}

/* ---------- tables ---------- */
.tbl { border:1px solid var(--line); border-radius:var(--r); overflow:hidden; background:var(--panel); }
.tbl-scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; min-width:680px; }
th,td { text-align:left; padding:13px 18px; border-bottom:1px solid var(--line); font-size:14px; }
th {
  color:var(--dimmer); font-weight:560; font-size:11.5px; letter-spacing:.09em;
  text-transform:uppercase; white-space:nowrap; background:rgba(255,255,255,.015);
}
tbody tr:last-child td { border-bottom:none; }
tbody tr:hover td { background:rgba(255,255,255,.022); }
td a { color:var(--accent); }
td a:hover { text-decoration:underline; }
.note { color:var(--dim); font-size:14px; margin:16px 0 0; max-width:74ch; }

/* the scorecard reads as the headline result, so give it weight */
.score td:first-child { font-weight:520; }
.score .win { color:var(--ok); font-weight:600; font-family:var(--mono); }
.score .lose { color:var(--bad); font-family:var(--mono); }
.score .flat { color:var(--dim); font-family:var(--mono); }

/* ---------- footer ---------- */
.cta-panel {
  margin-top:90px; border:1px solid rgba(139,124,255,.28); border-radius:20px;
  background:linear-gradient(135deg,rgba(139,124,255,.16),rgba(139,124,255,.03) 55%,transparent);
  padding:44px 40px; display:flex; gap:28px; align-items:center; justify-content:space-between; flex-wrap:wrap;
}
.cta-panel h2 { margin:0 0 8px; font-size:clamp(23px,3vw,31px); }
.cta-panel p { margin:0; color:var(--dim); max-width:52ch; font-size:15.5px; }
footer { margin-top:64px; border-top:1px solid var(--line); padding:30px 0 56px; color:var(--dimmer); font-size:13.5px; }
.foot-in { display:flex; gap:20px; justify-content:space-between; flex-wrap:wrap; align-items:center; }
footer code { font-family:var(--mono); color:var(--dim); }
footer a { color:var(--dim); }
footer a:hover { color:var(--text); }
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%F0%9F%9B%A1%3C/text%3E%3C/svg%3E" />
<style>${CSS}</style>
</head>
<body>

<nav>
  <div class="wrap nav-in">
    <a class="brand" href="#top"><span class="brand-mark"></span>Bulwark</a>
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
    <div class="badge"><span class="dot"></span> KeeperHub · Agents Onchain</div>
    <h1>Liquidation defense that knows <span class="grad">when not to act</span>.</h1>
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
    <div class="stat accent">
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
    <div class="sec-head center">
      <div class="eyebrow">Measured, not claimed</div>
      <h2>Landing the transaction is the hard part.</h2>
      <p class="sub">
        Spotting a position in danger is easy. Getting the rescue mined at 3am during a
        gas spike is not. So we measured it: identical workloads, same unusable gas
        price, KeeperHub against plain ethers.js.
      </p>
    </div>
    <div class="tbl tbl-scroll">
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
    </div>
    <p class="note">
      Sepolia, 2026-08-02, four trials per cell. One cell reads "no data" rather than 0%
      because those trials failed on our own network, and charging that to a backend
      would measure our connection instead of the thing under test. Revert shows no
      difference and is reported as such rather than dressed up.
      <a href="${REPO}/blob/main/chaos/RESULTS.md" style="color:var(--accent)">Method and raw data →</a>
    </p>
  </div>
</section>

<section id="position">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">At snapshot time</div>
      <h2>The position, and what the agent decided.</h2>
    </div>
    <div class="cards">
      <div class="card">
        <h3>Health factor</h3>
        <div class="hero-num">${hf}</div>
        <div style="margin-top:12px"><span class="pill tier-${p ? esc(p.tier) : 'IDLE'}">${p ? esc(p.tier) : 'unknown'}</span></div>
      </div>
      <div class="card">
        <h3>Position</h3>
        <div class="row"><span class="dim">collateral</span><b>${p ? usd(p.collateralUsd) : '?'}</b></div>
        <div class="row"><span class="dim">debt</span><b>${p ? usd(p.debtUsd) : '?'}</b></div>
        <div class="row"><span class="dim">liq. threshold</span><b>${p ? (p.liquidationThreshold * 100).toFixed(0) + '%' : '?'}</b></div>
      </div>
      <div class="card">
        <h3>Keeper ammunition</h3>
        <div class="row"><span class="dim">USDC</span><b>${s.keeper ? esc(s.keeper.usdc) : '?'}</b></div>
        <div class="row"><span class="dim">LINK</span><b>${s.keeper ? esc(s.keeper.link) : '?'}</b></div>
        <div class="row"><span class="dim" style="font-size:13px">spent on behalf of the position</span></div>
      </div>
      <div class="card">
        <h3>Economics</h3>
        <div class="row"><span class="dim">P(liquidation)</span><b>${d ? (d.liquidationProbability * 100).toFixed(2) + '%' : '?'}</b></div>
        <div class="row"><span class="dim">expected loss</span><b>${d ? usd(d.expectedLossUsd) : '?'}</b></div>
        <div class="row"><span class="dim">rescue cost</span><b>${d ? usd(d.rescueCostUsd) : '?'}</b></div>
      </div>
    </div>
    ${d ? `<div class="rationale">${esc(d.rationale)}</div>` : ''}
  </div>
</section>

<section id="trail">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">Public record</div>
      <h2>Every decision, on Ethereum mainnet.</h2>
      <p class="sub">
        Holds are attested as well as rescues. The declined rescues are the interesting
        judgment calls, and a log that omits them proves nothing.
      </p>
    </div>
    <div class="tbl tbl-scroll">
      <table>
        <thead><tr>
          <th>When</th><th>Action</th><th class="num">HF</th><th class="num">Expected loss</th>
          <th class="num">Rescue cost</th><th>Attestation</th><th>Remediation</th>
        </tr></thead>
        <tbody>
${attestationRows(s)}
        </tbody>
      </table>
    </div>
    <p class="note">
      Contract <a href="https://etherscan.io/address/${GUARDIAN_LOG}" style="color:var(--accent)" class="mono">${esc(GUARDIAN_LOG)}</a>,
      deployed through a CREATE3 factory on sponsored gas
      (<a href="${ethTx(DEPLOY_TX)}" style="color:var(--accent)">deployment</a>).
      Storage-free by design, so an attestation costs only the base transaction plus log data.
    </p>
  </div>
</section>

<section id="runs">
  <div class="wrap">
    <div class="sec-head">
      <div class="eyebrow">Running unattended</div>
      <h2>The watcher, still firing.</h2>
      <p class="sub">
        A KeeperHub workflow owns the CRITICAL tier server-side, so the position stays
        defended whether or not anything of ours is running. Showing the
        ${Math.min(SITE_RUN_LIMIT, s.workflowRuns.length)} most recent of ${s.totalWorkflowRuns}.
      </p>
    </div>
    <div class="tbl tbl-scroll">
      <table>
        <thead><tr>
          <th>Started</th><th>Trigger</th><th>Status</th><th class="num">Steps</th><th>Transactions</th>
        </tr></thead>
        <tbody>
${runRows(s)}
        </tbody>
      </table>
    </div>
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
      Watching <code>${esc(s.config.watchedWallet)}</code> on Sepolia.
    </div>
    <div>Regenerate with <code>npm run site:build</code></div>
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

// A snapshot missing the thing it exists to show is worse than no snapshot: it
// would publish an empty page that reads as "the agent never did anything".
if (state.attestations.length === 0) {
  console.error('\nRefusing to build: no attestations. Check the ledger.');
  process.exit(1);
}

const outDir = join(here, 'dist');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), render(state), 'utf8');

console.log(`Wrote site/dist/index.html`);
console.log(`  ${state.attestations.length} attestations`);
console.log(`  ${state.workflowRuns.length} of ${state.totalWorkflowRuns} workflow runs`);
console.log(`  position HF ${state.position?.healthFactor?.toFixed(4) ?? 'n/a'}`);

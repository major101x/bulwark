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
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getState, type DashboardState } from '../dashboard/data.ts';

const here = dirname(fileURLToPath(import.meta.url));

const REPO = 'https://github.com/major101x/bulwark';
const GUARDIAN_LOG = '0x06D8C09B5dbb9f9Bb96B7B20a351cdC5e16644D3';

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
      <td class="dim nowrap">${when(a.timestamp)}</td>
      <td><span class="badge ${a.action === 'HOLD' ? 'IDLE' : 'ARMED'}">${esc(a.action)}</span></td>
      <td class="num">${a.healthFactor.toFixed(4)}</td>
      <td class="num">${usd(a.expectedLossUsd)}</td>
      <td class="num">${usd(a.rescueCostUsd)}</td>
      <td><a href="${ethTx(a.txHash)}" target="_blank" rel="noopener">${short(a.txHash)}</a></td>
      <td>${
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
    .map(
      (r) => `<tr>
      <td class="dim nowrap">${when(r.startedAt)}</td>
      <td>${esc(r.triggerSource)}</td>
      <td class="${r.status === 'success' ? 'ok' : 'bad'}">${esc(r.status)}</td>
      <td class="num">${r.completedSteps}</td>
      <td>${
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

function render(s: DashboardState): string {
  const p = s.position;
  const d = s.decision;
  const hf = p && p.healthFactor !== null ? p.healthFactor.toFixed(4) : '∞';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Bulwark</title>
<meta name="description" content="A liquidation-defense keeper that executes onchain through KeeperHub, and declines to act when the gas is not worth it." />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext y='14' font-size='14'%3E%F0%9F%9B%A1%3C/text%3E%3C/svg%3E" />
<style>
  :root {
    --bg:#fff; --panel:#f6f8fa; --line:#d0d7de; --text:#1f2328; --dim:#656d76;
    --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e; --accent:#0969da;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --panel:#161b22; --line:#272e38; --text:#e6edf3; --dim:#8b949e;
      --ok:#3fb950; --warn:#d29922; --bad:#f85149; --accent:#58a6ff;
    }
  }
  * { box-sizing:border-box; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font-family:var(--mono); font-size:13.5px; line-height:1.6;
  }
  .wrap { max-width:1040px; margin:0 auto; padding:32px 16px 72px; }
  h1 { font-size:26px; margin:0 0 6px; letter-spacing:-.5px; }
  .tagline { font-size:15px; color:var(--text); margin:0 0 14px; max-width:62ch; }
  .links { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:22px; font-size:12.5px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .snapshot {
    background:rgba(210,153,34,.12); border:1px solid rgba(210,153,34,.45);
    border-radius:6px; padding:11px 14px; margin-bottom:26px; font-size:12.5px;
  }
  .snapshot b { color:var(--warn); }
  h2 {
    font-size:11.5px; text-transform:uppercase; letter-spacing:.8px;
    color:var(--dim); margin:32px 0 12px; font-weight:600;
  }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(196px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; }
  .card h3 {
    font-size:10.5px; text-transform:uppercase; letter-spacing:.7px;
    color:var(--dim); margin:0 0 8px; font-weight:600;
  }
  .big { font-size:29px; font-weight:600; letter-spacing:-1px; line-height:1.1; }
  .badge {
    display:inline-block; padding:2px 9px; border-radius:999px;
    font-size:10.5px; font-weight:600; letter-spacing:.4px;
  }
  .IDLE{background:rgba(63,185,80,.16);color:var(--ok)}
  .WATCH{background:rgba(88,166,255,.16);color:var(--accent)}
  .ARMED{background:rgba(210,153,34,.16);color:var(--warn)}
  .CRITICAL{background:rgba(248,81,73,.16);color:var(--bad)}
  .rationale {
    background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--accent);
    border-radius:6px; padding:13px 15px; white-space:pre-wrap; word-break:break-word;
  }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:8px; }
  table { border-collapse:collapse; width:100%; min-width:660px; }
  th,td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); }
  th {
    color:var(--dim); font-weight:600; font-size:10.5px;
    text-transform:uppercase; letter-spacing:.5px; white-space:nowrap;
  }
  tr:last-child td { border-bottom:none; }
  .num { text-align:right; }
  .nowrap { white-space:nowrap; }
  .dim { color:var(--dim); }
  .ok { color:var(--ok); }
  .bad { color:var(--bad); }
  .note { color:var(--dim); font-size:12.5px; max-width:70ch; }
  footer {
    margin-top:44px; padding-top:18px; border-top:1px solid var(--line);
    color:var(--dim); font-size:12px;
  }
</style>
</head>
<body>
<div class="wrap">

  <h1>Bulwark</h1>
  <p class="tagline">
    A liquidation-defense keeper that executes onchain through KeeperHub,
    and declines to act when the gas is not worth it.
  </p>
  <div class="links">
    <a href="${REPO}">Source on GitHub</a>
    <a href="https://etherscan.io/address/${GUARDIAN_LOG}">GuardianLog on mainnet</a>
    <a href="${REPO}/blob/main/chaos/RESULTS.md">Chaos harness results</a>
    <a href="${REPO}/tree/main/starter-template">Starter template</a>
  </div>

  <div class="snapshot">
    <b>This is a static snapshot</b>, taken ${when(s.fetchedAt)}. It does not update.
    The live dashboard is a local server (<code>npm run dashboard</code>): it reads a
    KeeperHub API key, so it cannot be deployed as a public page without handing that
    key to the browser. Every row below links to a block explorer, where the
    underlying record is live and verifiable.
  </div>

  <h2>Reliability, measured</h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Scenario</th><th>KeeperHub</th><th>ethers (blind gas limit)</th><th>ethers (default)</th>
      </tr></thead>
      <tbody>
        <tr><td>Gas underpricing (0.05 gwei vs ~0.98 market)</td><td class="ok">4/4 landed</td><td class="bad">0/4, all stuck</td><td class="dim">no data</td></tr>
        <tr><td>Congestion (4 concurrent from one wallet)</td><td class="ok">4/4 landed</td><td>1/4</td><td>2/4</td></tr>
        <tr><td>Revert</td><td>all refused</td><td>all refused</td><td>all refused</td></tr>
      </tbody>
    </table>
  </div>
  <p class="note">
    Sepolia, 2026-08-02, four trials per cell. Both sides got the same unusable gas
    price. One cell reads "no data" rather than 0% because those trials failed on our
    own network, and charging that to a backend would be measuring our connection
    instead of the thing under test. Revert shows no difference and is reported as
    such rather than dressed up.
  </p>

  <h2>Position and decision at snapshot time</h2>
  <div class="grid">
    <div class="card">
      <h3>Health factor</h3>
      <div class="big">${hf}</div>
      <div style="margin-top:7px"><span class="badge ${p ? esc(p.tier) : ''}">${p ? esc(p.tier) : 'unknown'}</span></div>
    </div>
    <div class="card">
      <h3>Position</h3>
      <div>collateral <b>${p ? usd(p.collateralUsd) : '?'}</b></div>
      <div>debt <b>${p ? usd(p.debtUsd) : '?'}</b></div>
      <div class="dim">liq. threshold ${p ? (p.liquidationThreshold * 100).toFixed(0) + '%' : '?'}</div>
    </div>
    <div class="card">
      <h3>Keeper ammunition</h3>
      <div>USDC <b>${s.keeper ? esc(s.keeper.usdc) : '?'}</b></div>
      <div>LINK <b>${s.keeper ? esc(s.keeper.link) : '?'}</b></div>
      <div class="dim">spent on behalf of the position</div>
    </div>
    <div class="card">
      <h3>Economics</h3>
      <div>P(liquidation) <b>${d ? (d.liquidationProbability * 100).toFixed(2) + '%' : '?'}</b></div>
      <div>expected loss <b>${d ? usd(d.expectedLossUsd) : '?'}</b></div>
      <div>rescue cost <b>${d ? usd(d.rescueCostUsd) : '?'}</b></div>
    </div>
  </div>

  ${
    d
      ? `<h2>Current decision · ${esc(d.action)}</h2>
  <div class="rationale">${esc(d.rationale)}</div>`
      : ''
  }

  <h2>Decision trail · GuardianLog on Ethereum mainnet</h2>
  <div class="scroll">
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
    Holds are attested as well as rescues. A keeper that only records its successes is
    not an audit trail, and the declined rescues are the interesting judgment calls.
  </p>

  <h2>Execution trail · KeeperHub workflow runs
    <span class="dim" style="text-transform:none;letter-spacing:0">(${s.workflowRuns.length} of ${s.totalWorkflowRuns})</span>
  </h2>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>Started</th><th>Trigger</th><th>Status</th><th class="num">Steps</th><th>Transactions</th>
      </tr></thead>
      <tbody>
${runRows(s)}
      </tbody>
    </table>
  </div>

  <footer>
    Built for the KeeperHub <em>Agents Onchain</em> hackathon.
    Watched position <code>${esc(s.config.watchedWallet)}</code> on Sepolia,
    attesting to <code>${esc(GUARDIAN_LOG)}</code> on Ethereum mainnet.
    Regenerate this page with <code>npm run site:build</code>.
  </footer>

</div>
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

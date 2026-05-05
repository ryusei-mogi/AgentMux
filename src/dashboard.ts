import type { AppConfig, UpstreamStats } from './types.js';
import type { UsageStore } from './db.js';
import { windowStart } from './time.js';

export function renderDashboard(config: AppConfig, store: UsageStore): string {
  const since = windowStart('daily');
  const usage = store.getUsageSince(since);
  const rows = config.upstreams.map((upstream) => {
    const state = store.recoverExpiredCooldown(upstream.id);
    const stats = usage.find((item) => item.upstream_id === upstream.id) ?? emptyStats(upstream.id);
    const cooldown = state.cooldown_until ? new Date(state.cooldown_until).toLocaleString() : '-';
    return `<tr>
      <td>${escapeHtml(upstream.id)}</td>
      <td><span class="badge ${state.state}">${state.state}</span></td>
      <td>${stats.requests}</td>
      <td>${stats.successes}</td>
      <td>${stats.errors}</td>
      <td>${stats.input_tokens}</td>
      <td>${stats.output_tokens}</td>
      <td>$${stats.estimated_cost.toFixed(4)}</td>
      <td>${Math.round(stats.average_latency_ms)}ms</td>
      <td>${escapeHtml(cooldown)}</td>
    </tr>`;
  });
  const totals = usage.reduce(
    (acc, item) => ({
      requests: acc.requests + item.requests,
      cost: acc.cost + item.estimated_cost,
      input: acc.input + item.input_tokens,
      output: acc.output + item.output_tokens
    }),
    { requests: 0, cost: 0, input: 0, output: 0 }
  );
  const maxCost = Math.max(...usage.map((item) => item.estimated_cost), 0);
  const costRows =
    usage.length > 0
      ? usage
          .map((item) => {
            const width = maxCost > 0 ? Math.max(2, (item.estimated_cost / maxCost) * 100) : 0;
            return `<div class="bar-row">
      <span>${escapeHtml(item.upstream_id)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${width.toFixed(2)}%"></div></div>
      <strong>$${item.estimated_cost.toFixed(4)}</strong>
    </div>`;
          })
          .join('')
      : '<p class="empty">No usage recorded today.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentMux dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f6f8fb; --panel:#ffffff; --text:#172033; --muted:#637087; --line:#dfe5ef; --accent:#0f766e; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    main { max-width:1180px; margin:0 auto; padding:32px 20px; }
    header { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:24px; }
    h1 { margin:0; font-size:34px; letter-spacing:0; }
    p { color:var(--muted); margin:8px 0 0; }
    .grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:14px; margin-bottom:18px; }
    .card, .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; box-shadow:0 10px 28px rgba(23,32,51,.06); }
    .card { padding:18px; }
    .card strong { display:block; font-size:26px; margin-top:6px; }
    .label { color:var(--muted); font-size:13px; }
    .panel { padding:18px; margin-top:16px; overflow:auto; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { text-align:left; padding:12px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
    th { color:var(--muted); font-weight:600; }
    .badge { display:inline-block; padding:4px 9px; border-radius:999px; font-size:12px; font-weight:700; }
    .bar-row { display:grid; grid-template-columns:180px minmax(160px,1fr) 96px; gap:12px; align-items:center; padding:10px 0; }
    .bar-row + .bar-row { border-top:1px solid var(--line); }
    .bar-row span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .bar-row strong { text-align:right; font-size:14px; }
    .bar-track { height:12px; background:#e8eef6; border-radius:999px; overflow:hidden; }
    .bar-fill { height:100%; background:var(--accent); border-radius:999px; }
    .empty { margin:0; }
    .healthy { background:#dcfce7; color:#166534; }
    .probation { background:#fef9c3; color:#854d0e; }
    .cooldown { background:#fee2e2; color:#991b1b; }
    .disabled { background:#e5e7eb; color:#374151; }
    @media (max-width: 760px) { .grid { grid-template-columns:1fr 1fr; } header { display:block; } .bar-row { grid-template-columns:1fr; } .bar-row strong { text-align:left; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>AgentMux</h1><p>Quota-aware local LLM routing status for coding agents.</p></div>
      <p>${new Date().toLocaleString()}</p>
    </header>
    <section class="grid">
      <div class="card"><span class="label">Requests today</span><strong>${totals.requests}</strong></div>
      <div class="card"><span class="label">Estimated cost</span><strong>$${totals.cost.toFixed(4)}</strong></div>
      <div class="card"><span class="label">Input tokens</span><strong>${totals.input}</strong></div>
      <div class="card"><span class="label">Output tokens</span><strong>${totals.output}</strong></div>
    </section>
    <section class="panel">${costRows}</section>
    <section class="panel"><table><thead><tr><th>Upstream</th><th>State</th><th>Requests</th><th>OK</th><th>Errors</th><th>Input</th><th>Output</th><th>Cost</th><th>Latency</th><th>Cooldown until</th></tr></thead><tbody>${rows.join('')}</tbody></table></section>
  </main>
</body>
</html>`;
}

function emptyStats(upstreamId: string): UpstreamStats {
  return {
    upstream_id: upstreamId,
    requests: 0,
    successes: 0,
    errors: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    estimated_cost: 0,
    average_latency_ms: 0
  };
}

function escapeHtml(input: string): string {
  return input.replace(
    /[&<>'"]/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char] ?? char
  );
}

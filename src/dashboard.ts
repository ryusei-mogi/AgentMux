import type {
  AppConfig,
  RoutingStrategy,
  UpstreamBudgetConfig,
  UpstreamConfig,
  UpstreamStats,
  UpstreamType
} from './types.js';
import type { UsageStore } from './db.js';
import { windowStart } from './time.js';

const REFRESH_INTERVAL_SECONDS = 15;

export interface DashboardData {
  generated_at: string;
  totals: DashboardTotals;
  upstreams: DashboardUpstream[];
  recent_errors: DashboardRecentError[];
  models: DashboardModel[];
}

interface DashboardTotals {
  requests: number;
  successes: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  average_latency_ms: number;
  upstreams: number;
  available_upstreams: number;
}

interface DashboardUpstream {
  id: string;
  type: UpstreamType;
  state: string;
  model_count: number;
  requests: number;
  successes: number;
  errors: number;
  success_rate: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  estimated_cost: number;
  average_latency_ms: number;
  cooldown_until?: string | undefined;
  last_error?: string | undefined;
  budget?: {
    window: UpstreamBudgetConfig['window'];
    limit_usd: number;
    used_usd: number;
    remaining_usd: number;
    percent_used: number;
  };
}

interface DashboardRecentError {
  created_at: string;
  upstream_id: string;
  model: string;
  http_status: number | null;
  error_type: string | null;
}

interface DashboardModel {
  name: string;
  strategy: RoutingStrategy;
  upstream_count: number;
}

export function dashboardData(config: AppConfig, store: UsageStore): DashboardData {
  const now = Date.now();
  const since = windowStart('daily', now);
  const usage = store.getUsageSince(since);
  const statsByUpstream = new Map(usage.map((item) => [item.upstream_id, item]));
  const upstreams = config.upstreams.map((upstream) =>
    upstreamData(upstream, statsByUpstream.get(upstream.id) ?? emptyStats(upstream.id), store, now)
  );
  const totals = upstreams.reduce(
    (acc, item) => ({
      requests: acc.requests + item.requests,
      successes: acc.successes + item.successes,
      errors: acc.errors + item.errors,
      input_tokens: acc.input_tokens + item.input_tokens,
      output_tokens: acc.output_tokens + item.output_tokens,
      cached_tokens: acc.cached_tokens + item.cached_tokens,
      estimated_cost: acc.estimated_cost + item.estimated_cost,
      latency_sum: acc.latency_sum + item.average_latency_ms * item.requests
    }),
    {
      requests: 0,
      successes: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      estimated_cost: 0,
      latency_sum: 0
    }
  );

  return {
    generated_at: new Date().toISOString(),
    totals: {
      requests: totals.requests,
      successes: totals.successes,
      errors: totals.errors,
      input_tokens: totals.input_tokens,
      output_tokens: totals.output_tokens,
      cached_tokens: totals.cached_tokens,
      estimated_cost: totals.estimated_cost,
      average_latency_ms: totals.requests > 0 ? totals.latency_sum / totals.requests : 0,
      upstreams: upstreams.length,
      available_upstreams: upstreams.filter(
        (item) => item.state === 'healthy' || item.state === 'probation'
      ).length
    },
    upstreams,
    recent_errors: store.getRecentErrors(8).map((error) => ({
      ...error,
      created_at: new Date(error.created_at).toISOString()
    })),
    models: Object.entries(config.models).map(([name, route]) => ({
      name,
      strategy: route.strategy ?? config.routing.default_strategy,
      upstream_count: route.upstreams.length
    }))
  };
}

export function renderDashboard(config: AppConfig, store: UsageStore): string {
  const data = dashboardData(config, store);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentMux dashboard</title>
  <style>
    :root { color-scheme: light; --bg:#f3f7fb; --panel:#ffffff; --text:#152033; --muted:#647186; --line:#dce4ef; --soft:#eef4fb; --accent:#0f766e; --accent-2:#2563eb; --warn:#b45309; --bad:#b91c1c; --good:#15803d; --shadow:0 18px 45px rgba(21,32,51,.10); }
    * { box-sizing:border-box; }
    body { margin:0; font-family:ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:linear-gradient(180deg,#eaf2fb 0,#f8fbfd 360px,var(--bg) 100%); color:var(--text); }
    button, input, select { font:inherit; }
    main { max-width:1240px; margin:0 auto; padding:26px 20px 36px; }
    header { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:20px; align-items:start; margin-bottom:20px; }
    h1 { margin:0; font-size:42px; line-height:1; letter-spacing:0; }
    h2 { margin:0; font-size:18px; letter-spacing:0; }
    p { margin:0; color:var(--muted); }
    .eyebrow { color:var(--accent); font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:.08em; margin-bottom:10px; }
    .hero-copy { max-width:640px; margin-top:12px; font-size:16px; line-height:1.6; }
    .status-pill { justify-self:end; min-width:230px; padding:14px 16px; border:1px solid rgba(15,118,110,.22); background:rgba(255,255,255,.72); border-radius:8px; box-shadow:var(--shadow); }
    .status-pill strong { display:block; font-size:15px; }
    .status-pill span { display:block; margin-top:5px; color:var(--muted); font-size:13px; }
    .toolbar { display:grid; grid-template-columns:minmax(220px,1fr) 160px 160px auto; gap:10px; margin:20px 0; }
    .control { width:100%; min-height:42px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--text); padding:0 12px; }
    .refresh { border:0; border-radius:8px; min-height:42px; padding:0 14px; background:var(--text); color:#fff; font-weight:800; cursor:pointer; }
    .kpis { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:12px; }
    .card, .panel { background:rgba(255,255,255,.90); border:1px solid var(--line); border-radius:8px; box-shadow:var(--shadow); }
    .card { padding:16px; min-height:104px; }
    .label { color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
    .metric { display:block; margin-top:8px; font-size:28px; line-height:1.1; font-weight:850; }
    .submetric { display:block; margin-top:8px; color:var(--muted); font-size:13px; }
    .layout { display:grid; grid-template-columns:minmax(0,1.7fr) minmax(300px,.8fr); gap:14px; margin-top:14px; align-items:start; }
    .panel { padding:16px; overflow:hidden; }
    .panel-head { display:flex; justify-content:space-between; gap:12px; align-items:center; margin-bottom:12px; }
    .bars { display:grid; gap:10px; }
    .bar-row { display:grid; grid-template-columns:minmax(110px,1fr) minmax(120px,2fr) 80px; gap:10px; align-items:center; font-size:13px; }
    .bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:750; }
    .bar-track { height:10px; background:var(--soft); border-radius:999px; overflow:hidden; }
    .bar-fill { height:100%; width:0; background:linear-gradient(90deg,var(--accent),var(--accent-2)); border-radius:999px; transition:width .2s ease; }
    .bar-value { text-align:right; color:var(--muted); }
    .table-wrap { overflow:auto; border:1px solid var(--line); border-radius:8px; }
    table { width:100%; border-collapse:collapse; min-width:930px; font-size:14px; }
    th, td { text-align:left; padding:12px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
    th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; background:#f8fbff; cursor:pointer; user-select:none; }
    tr:last-child td { border-bottom:0; }
    .badge { display:inline-flex; align-items:center; min-height:24px; padding:0 9px; border-radius:999px; font-size:12px; font-weight:850; }
    .healthy { background:#dcfce7; color:#166534; }
    .probation { background:#fef3c7; color:#92400e; }
    .cooldown { background:#fee2e2; color:#991b1b; }
    .disabled { background:#e5e7eb; color:#374151; }
    .muted { color:var(--muted); }
    .stack { display:grid; gap:14px; }
    .list { display:grid; gap:9px; }
    .list-item { border:1px solid var(--line); border-radius:8px; padding:11px; background:#fbfdff; }
    .list-item strong { display:block; font-size:14px; }
    .list-item span { display:block; margin-top:4px; color:var(--muted); font-size:12px; }
    .empty { color:var(--muted); padding:12px; border:1px dashed var(--line); border-radius:8px; background:#fbfdff; }
    .budget { color:var(--muted); font-size:12px; }
    @media (max-width:980px) { header, .layout, .toolbar { grid-template-columns:1fr; } .status-pill { justify-self:stretch; } .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
    @media (max-width:620px) { main { padding:20px 14px 28px; } h1 { font-size:34px; } .kpis { grid-template-columns:1fr; } .bar-row { grid-template-columns:1fr; } .bar-value { text-align:left; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Local routing command center</div>
        <h1>AgentMux</h1>
        <p class="hero-copy">Quota-aware LLM routing with live upstream health, spend, latency, and recent failure context.</p>
      </div>
      <div class="status-pill">
        <strong id="overall-status">Preparing dashboard</strong>
        <span id="last-updated">Refreshes every ${REFRESH_INTERVAL_SECONDS}s</span>
      </div>
    </header>
    <section class="kpis" aria-label="Dashboard totals">
      <div class="card"><span class="label">Requests today</span><strong class="metric" id="kpi-requests">0</strong><span class="submetric" id="kpi-successes">0 successful</span></div>
      <div class="card"><span class="label">Estimated cost</span><strong class="metric" id="kpi-cost">$0.0000</strong><span class="submetric">Today</span></div>
      <div class="card"><span class="label">Tokens</span><strong class="metric" id="kpi-tokens">0</strong><span class="submetric" id="kpi-cached">0 cached</span></div>
      <div class="card"><span class="label">Errors</span><strong class="metric" id="kpi-errors">0</strong><span class="submetric" id="kpi-error-rate">0.0% error rate</span></div>
      <div class="card"><span class="label">Avg latency</span><strong class="metric" id="kpi-latency">0ms</strong><span class="submetric" id="kpi-upstreams">0 upstreams</span></div>
    </section>
    <section class="toolbar" aria-label="Dashboard controls">
      <input class="control" id="search" type="search" placeholder="Search upstreams">
      <select class="control" id="state-filter"><option value="">All states</option><option>healthy</option><option>probation</option><option>cooldown</option><option>disabled</option></select>
      <select class="control" id="type-filter"><option value="">All types</option><option>openai-compatible</option></select>
      <button class="refresh" id="refresh" type="button">Refresh</button>
    </section>
    <section class="layout">
      <div class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Upstreams</h2><p id="upstream-count">0 shown</p></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th data-sort="id">Upstream</th><th data-sort="state">State</th><th data-sort="type">Type</th><th data-sort="requests">Requests</th><th data-sort="success_rate">Success</th><th data-sort="estimated_cost">Cost</th><th data-sort="average_latency_ms">Latency</th><th>Budget</th><th>Cooldown</th></tr></thead>
              <tbody id="upstreams-body"></tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Cost and request mix</h2><p class="muted">Today</p></div>
          <div class="bars" id="usage-bars"></div>
        </section>
      </div>
      <aside class="stack">
        <section class="panel">
          <div class="panel-head"><h2>Recent errors</h2><p class="muted">Latest 8</p></div>
          <div class="list" id="recent-errors"></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Model routes</h2><p class="muted">Configured</p></div>
          <div class="list" id="model-routes"></div>
        </section>
      </aside>
    </section>
  </main>
  <script id="dashboard-data" type="application/json">${jsonForScript(data)}</script>
  <script>
    const refreshIntervalMs = ${REFRESH_INTERVAL_SECONDS * 1000};
    let dashboardData = JSON.parse(document.getElementById('dashboard-data').textContent);
    let sortKey = 'estimated_cost';
    let sortDirection = -1;
    const byId = (id) => document.getElementById(id);
    const numberFormat = new Intl.NumberFormat();
    const money = (value) => '$' + Number(value || 0).toFixed(4);
    const percent = (value) => Number(value || 0).toFixed(1) + '%';
    const ms = (value) => Math.round(Number(value || 0)) + 'ms';
    const time = (value) => value ? new Date(value).toLocaleString() : '-';
    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);

    function render(data) {
      const totals = data.totals;
      const tokenTotal = totals.input_tokens + totals.output_tokens;
      byId('kpi-requests').textContent = numberFormat.format(totals.requests);
      byId('kpi-successes').textContent = numberFormat.format(totals.successes) + ' successful';
      byId('kpi-cost').textContent = money(totals.estimated_cost);
      byId('kpi-tokens').textContent = numberFormat.format(tokenTotal);
      byId('kpi-cached').textContent = numberFormat.format(totals.cached_tokens) + ' cached';
      byId('kpi-errors').textContent = numberFormat.format(totals.errors);
      byId('kpi-error-rate').textContent = percent(totals.requests ? totals.errors / totals.requests * 100 : 0) + ' error rate';
      byId('kpi-latency').textContent = ms(totals.average_latency_ms);
      byId('kpi-upstreams').textContent = totals.available_upstreams + ' of ' + totals.upstreams + ' available';
      byId('overall-status').textContent = totals.available_upstreams > 0 ? 'Routing capacity available' : 'No available upstreams';
      byId('last-updated').textContent = 'Updated ' + time(data.generated_at);
      renderUpstreams(data.upstreams);
      renderBars(data.upstreams);
      renderErrors(data.recent_errors);
      renderModels(data.models);
    }

    function filteredUpstreams(upstreams) {
      const query = byId('search').value.trim().toLowerCase();
      const state = byId('state-filter').value;
      const type = byId('type-filter').value;
      return upstreams
        .filter((item) => !query || item.id.toLowerCase().includes(query))
        .filter((item) => !state || item.state === state)
        .filter((item) => !type || item.type === type)
        .sort((a, b) => {
          const left = a[sortKey];
          const right = b[sortKey];
          if (typeof left === 'number' && typeof right === 'number') return (left - right) * sortDirection;
          return String(left ?? '').localeCompare(String(right ?? '')) * sortDirection;
        });
    }

    function renderUpstreams(upstreams) {
      const rows = filteredUpstreams(upstreams);
      byId('upstream-count').textContent = rows.length + ' shown';
      byId('upstreams-body').innerHTML = rows.map((item) => {
        const budget = item.budget ? escapeText(percent(item.budget.percent_used) + ' of ' + money(item.budget.limit_usd)) : '<span class="muted">Not set</span>';
        return '<tr><td><strong>' + escapeText(item.id) + '</strong><div class="muted">' + item.model_count + ' models</div></td><td><span class="badge ' + escapeText(item.state) + '">' + escapeText(item.state) + '</span></td><td>' + escapeText(item.type) + '</td><td>' + numberFormat.format(item.requests) + '</td><td>' + percent(item.success_rate) + '</td><td>' + money(item.estimated_cost) + '</td><td>' + ms(item.average_latency_ms) + '</td><td class="budget">' + budget + '</td><td>' + escapeText(time(item.cooldown_until)) + '</td></tr>';
      }).join('') || '<tr><td colspan="9" class="empty">No upstreams match the current filters.</td></tr>';
    }

    function renderBars(upstreams) {
      const max = Math.max(...upstreams.map((item) => Math.max(item.estimated_cost, item.requests)), 0);
      byId('usage-bars').innerHTML = upstreams.map((item) => {
        const width = max > 0 ? Math.max(2, Math.max(item.estimated_cost, item.requests) / max * 100) : 0;
        return '<div class="bar-row"><div class="bar-label">' + escapeText(item.id) + '</div><div class="bar-track"><div class="bar-fill" style="width:' + width.toFixed(2) + '%"></div></div><div class="bar-value">' + money(item.estimated_cost) + ' / ' + numberFormat.format(item.requests) + '</div></div>';
      }).join('') || '<p class="empty">No usage recorded today.</p>';
    }

    function renderErrors(errors) {
      byId('recent-errors').innerHTML = errors.map((item) => '<div class="list-item"><strong>' + escapeText(item.upstream_id) + '</strong><span>' + escapeText(item.error_type || 'error') + ' · ' + escapeText(item.model) + ' · ' + escapeText(item.http_status ?? '-') + '</span><span>' + escapeText(time(item.created_at)) + '</span></div>').join('') || '<p class="empty">No recent errors.</p>';
    }

    function renderModels(models) {
      byId('model-routes').innerHTML = models.map((item) => '<div class="list-item"><strong>' + escapeText(item.name) + '</strong><span>' + escapeText(item.strategy) + ' · ' + item.upstream_count + ' upstreams</span></div>').join('') || '<p class="empty">No model routes configured.</p>';
    }

    async function refresh() {
      byId('last-updated').textContent = 'Refreshing...';
      try {
        const response = await fetch('/dashboard/data', { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        dashboardData = await response.json();
        render(dashboardData);
      } catch (error) {
        byId('last-updated').textContent = 'Refresh failed; showing last data';
      }
    }

    byId('search').addEventListener('input', () => renderUpstreams(dashboardData.upstreams));
    byId('state-filter').addEventListener('change', () => renderUpstreams(dashboardData.upstreams));
    byId('type-filter').addEventListener('change', () => renderUpstreams(dashboardData.upstreams));
    byId('refresh').addEventListener('click', refresh);
    document.querySelectorAll('th[data-sort]').forEach((header) => header.addEventListener('click', () => {
      const nextKey = header.getAttribute('data-sort');
      sortDirection = sortKey === nextKey ? sortDirection * -1 : -1;
      sortKey = nextKey;
      renderUpstreams(dashboardData.upstreams);
    }));
    render(dashboardData);
    setInterval(refresh, refreshIntervalMs);
  </script>
</body>
</html>`;
}

function upstreamData(
  upstream: UpstreamConfig,
  stats: UpstreamStats,
  store: UsageStore,
  now: number
): DashboardUpstream {
  const state = store.recoverExpiredCooldown(upstream.id);
  const budgetStats = upstream.budget
    ? store.getStats(upstream.id, windowStart(upstream.budget.window, now))
    : stats;
  const budget = upstream.budget
    ? {
        window: upstream.budget.window,
        limit_usd: upstream.budget.limit_usd,
        used_usd: budgetStats.estimated_cost,
        remaining_usd: Math.max(0, upstream.budget.limit_usd - budgetStats.estimated_cost),
        percent_used:
          upstream.budget.limit_usd > 0
            ? Math.min(100, (budgetStats.estimated_cost / upstream.budget.limit_usd) * 100)
            : 0
      }
    : undefined;
  return {
    id: upstream.id,
    type: upstream.type,
    state: state.state,
    model_count: Object.keys(upstream.models).length,
    requests: stats.requests,
    successes: stats.successes,
    errors: stats.errors,
    success_rate: stats.requests > 0 ? (stats.successes / stats.requests) * 100 : 100,
    input_tokens: stats.input_tokens,
    output_tokens: stats.output_tokens,
    cached_tokens: stats.cached_tokens,
    estimated_cost: stats.estimated_cost,
    average_latency_ms: stats.average_latency_ms,
    cooldown_until: state.cooldown_until ? new Date(state.cooldown_until).toISOString() : undefined,
    last_error: state.last_error,
    ...(budget ? { budget } : {})
  };
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

function jsonForScript(data: DashboardData): string {
  return JSON.stringify(data).replace(
    /[<>&]/g,
    (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' })[char] ?? char
  );
}

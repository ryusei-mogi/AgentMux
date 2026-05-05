import { windowStart } from './time.js';
import type {
  AppConfig,
  Candidate,
  RoutingStrategy,
  UpstreamConfig,
  UpstreamStats
} from './types.js';
import type { UsageStore } from './db.js';

export class RouterEngine {
  constructor(
    private config: AppConfig,
    private store: UsageStore
  ) {}

  select(model: string): Candidate[] {
    const route = this.config.models[model];
    if (!route) throw new Error(`Unknown model: ${model}`);

    const candidates = route.upstreams
      .map((id) => this.config.upstreams.find((u) => u.id === id))
      .filter((u): u is UpstreamConfig => Boolean(u))
      .filter((u) => Boolean(u.models[model]))
      .map((upstream) => this.toCandidate(upstream, model));

    const available = candidates.filter((candidate) => isAvailable(candidate));
    if (available.length === 0) return [];

    const strategy = route.strategy ?? this.config.routing.default_strategy;
    return orderCandidates(available, strategy, this.store, model);
  }

  private toCandidate(upstream: UpstreamConfig, model: string): Candidate {
    const state = this.store.recoverExpiredCooldown(upstream.id);
    const stats = this.store.getStats(
      upstream.id,
      upstream.budget ? windowStart(upstream.budget.window) : 0
    );
    const budgetRatio = remainingBudgetRatio(upstream, stats);
    const successRate = stats.requests === 0 ? 1 : stats.successes / stats.requests;
    const recentPenalty = stats.errors * 20;
    const latencyPenalty = stats.average_latency_ms / 100;
    const costPenalty = upstream.pricing
      ? ((upstream.pricing.input_per_million ?? 0) + (upstream.pricing.output_per_million ?? 0)) / 2
      : 0;
    return {
      upstream,
      upstreamModel: upstream.models[model] ?? model,
      state,
      stats,
      score: budgetRatio * 100 + successRate * 30 - recentPenalty - latencyPenalty - costPenalty
    };
  }
}

export function remainingBudgetRatio(upstream: UpstreamConfig, stats: UpstreamStats): number {
  if (!upstream.budget) return 1;
  return Math.max(
    0,
    (upstream.budget.limit_usd - stats.estimated_cost) / upstream.budget.limit_usd
  );
}

function isAvailable(candidate: Candidate): boolean {
  if (candidate.state.disabled || candidate.state.state === 'disabled') return false;
  if (candidate.state.state === 'cooldown') return false;
  if (
    candidate.upstream.budget &&
    candidate.stats.estimated_cost >= candidate.upstream.budget.limit_usd
  )
    return false;
  return true;
}

function orderCandidates(
  candidates: Candidate[],
  strategy: RoutingStrategy,
  store: UsageStore,
  model: string
): Candidate[] {
  if (strategy === 'fallback') return candidates;
  if (strategy === 'least_used')
    return [...candidates].sort((a, b) => a.stats.requests - b.stats.requests);
  if (strategy === 'cheapest') return [...candidates].sort((a, b) => costWeight(a) - costWeight(b));
  if (strategy === 'quota_aware') return [...candidates].sort((a, b) => b.score - a.score);
  if (strategy === 'weighted_round_robin') return weightedRoundRobin(candidates, store, model);
  return roundRobin(candidates, store, model);
}

function costWeight(candidate: Candidate): number {
  const pricing = candidate.upstream.pricing;
  if (!pricing) return 0;
  return (pricing.input_per_million ?? 0) + (pricing.output_per_million ?? 0);
}

function roundRobin(candidates: Candidate[], store: UsageStore, model: string): Candidate[] {
  const key = `rr:${model}`;
  const index = Number(store.getKv(key) ?? '0');
  store.setKv(key, String((index + 1) % candidates.length));
  return rotate(candidates, index % candidates.length);
}

function weightedRoundRobin(
  candidates: Candidate[],
  store: UsageStore,
  model: string
): Candidate[] {
  const expanded = candidates.flatMap((candidate) =>
    Array.from(
      { length: Math.max(1, Math.round(candidate.upstream.strategy_weight * 10)) },
      () => candidate
    )
  );
  const ordered = roundRobin(expanded, store, `weighted:${model}`);
  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    if (seen.has(candidate.upstream.id)) return false;
    seen.add(candidate.upstream.id);
    return true;
  });
}

function rotate<T>(values: T[], index: number): T[] {
  return [...values.slice(index), ...values.slice(0, index)];
}

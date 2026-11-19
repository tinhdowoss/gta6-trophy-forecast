// GTA VI trophy earn-rate forecaster for make.fun's gta6-trophy-rarity-forecast-01 (Node 22, standard library only).
//
// Exophase prints, for each trophy, rate = earners / players_tracked, and it only changes the page when it refreshes
// its counts. So this program:
//   1. reduces the house's reads to distinct refreshes (stale-cache flip-flops back to an older page are ignored),
//   2. turns every rate into an earner count (rate / 100 x players_tracked),
//   3. measures, in log-time u = ln(1 + hours since 2026-11-19T00:00Z), the recent slope of ln players_tracked, of
//      each trophy's ln earners and of its logit rate (noisy slopes of rare trophies shrunk toward a cross-sectional
//      curve of slope against rate),
//   4. extrapolates them to the last refresh expected before the target with slopes that decay in log-time
//      (saturating growth); the decays of players and of earners are chosen inside the case, by pseudo-forecasts cut
//      from its own history at the real log-time horizon, and shrunk toward a prior,
//   5. divides earners by players (the counts path, used for rare and mid trophies) and, near saturation, where that
//      ratio is ill-conditioned, leans on the decayed logit trend; story order is then enforced (Chapter 1 >= ... >=
//      the final mission, the platinum below every trophy),
//   6. sets five quantiles on the logit scale from the residuals of those same pseudo-forecasts, scaled to the real
//      horizon, by rate band, with a floor and extra width for rare trophies,
//   7. leans toward the house persistence baseline when the history is short, and falls back to that baseline for a
//      case on any internal error, so every output is valid.
//
// Run: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
// FORECAST_DEBUG=1 prints internals to stderr. FORECAST_PARAMS='{"name":value}' overrides tuning constants (backtest).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = Number(process.env.FORECAST_DEBUG ?? 0);

const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6449, -0.6745, 0, 0.6745, 1.6449];
const DECAY_GRID = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4];

/** Tuning constants (chosen on the backtest); FORECAST_PARAMS can override them for experiments. */
const PARAMS: Record<string, number> = {
  firstFitHours: 3, // refreshes earlier than this (hours after launch) are launch-night noise and not fitted
  slopeWindowU: 0.25, // slopes are measured over the last this-much log-time
  minWindowPoints: 4,
  earnersDecayPrior: 1, // slope decay per unit log-time when the case cannot tell
  playersDecayPrior: 1,
  decayPenalty: 1, // pull of the prior on the in-case decay choice (the in-case choice alone is noisy)
  shrinkEarners: 30, // earners at which a trophy's own slope and the cross-sectional curve's get equal weight
  countsRateCap: 25, // the counts path's weight falls linearly from 1 at 0% to 0 at this rate
  biasShare: 0.4, // share of the in-case pseudo-forecast median bias that is corrected
  sigmaPriorBase: 0.15, // prior logit spread (1 sd) = base + perU x delta-u
  sigmaPriorPerU: 0.7,
  sigmaFloorBase: 0.08,
  sigmaFloorPerU: 0.25,
  rareWiden: 0.1, // extra width below 1% (more toward 0.01%): real dynamics may differ from any backtest
  priorCuts: 4, // pseudo-forecast count at which the empirical and the prior spread get equal weight
  horizonPower: 1, // residuals scale as (real delta-u / pseudo delta-u) ^ horizonPower
  minPseudoShare: 0.3, // a pseudo-forecast must cover at least this share of the real delta-u
  shortShift: -0.6, // logit shift of the median when the history holds no post-launch refresh yet
};
try {
  Object.assign(PARAMS, JSON.parse(process.env.FORECAST_PARAMS ?? '{}'));
} catch {
  /* keep the defaults */
}

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
}
interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned?: number;
  rates: Array<number | null>;
}
interface Case {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Trophy[];
  history: Read[];
}
/** One distinct page state: Exophase's counts as of one refresh. */
interface Refresh {
  hours: number; // estimated refresh time, hours since launch
  firstSeenHours: number;
  players: number;
  rates: Array<number | null>;
}
type Row = { id: number; q: number[] };

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const p = clampPct(pct) / 100;
  return Math.log(p / (1 - p));
};
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const hoursOf = (iso: string): number => (Date.parse(iso) - LAUNCH_MS) / 3.6e6;
const logTime = (h: number): number => Math.log(1 + Math.max(0, h));
const hoursOfLogTime = (u: number): number => Math.exp(u) - 1;
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const median = (xs: number[]): number => weightedQuantile(xs, xs.map(() => 1), 0.5);

function weightedQuantile(xs: number[], ws: number[], tau: number): number {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b] || a - b);
  const total = ws.reduce((s, w) => s + w, 0);
  if (idx.length === 0 || total <= 0) return 0;
  let acc = 0;
  for (const i of idx) {
    acc += ws[i];
    if (acc >= tau * total) return xs[i];
  }
  return xs[idx[idx.length - 1]];
}

/** Solves a small dense linear system by Gaussian elimination with partial pivoting; null when singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-12) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

/** Weighted least squares of y on the given basis rows, with a ridge per coefficient. */
function weightedLeastSquares(xs: number[][], ys: number[], ws: number[], ridge: number[]): number[] | null {
  const k = ridge.length;
  const a = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (let i = 0; i < ys.length; i++) {
    for (let r = 0; r < k; r++) {
      b[r] += ws[i] * xs[i][r] * ys[i];
      for (let c = 0; c < k; c++) a[r][c] += ws[i] * xs[i][r] * xs[i][c];
    }
  }
  const wsum = ws.reduce((s, w) => s + w, 0);
  for (let r = 0; r < k; r++) a[r][r] += ridge[r] * wsum;
  return solveLinear(a, b);
}

/** Weighted slope of y against x (0 when x does not vary). */
function weightedSlope(xs: number[], ys: number[], ws: number[]): number {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
  }
  if (sw <= 0) return 0;
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += ws[i] * (xs[i] - mx) ** 2;
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
  }
  return sxx > 1e-12 ? sxy / sxx : 0;
}

/** Integral of exp(-decay s) ds from 0 to du: how much of today's slope the next du of log-time still gets. */
function decayedGrowth(decay: number, du: number): number {
  if (Math.abs(decay) < 1e-6) return du;
  return (1 - Math.exp(-decay * du)) / decay;
}

// ---------------------------------------------------------------------------------------------------------------------
// History -> refreshes -> counts

/** Reduces the reads to the distinct refreshes Exophase made, oldest first, each dated between the reads around it. */
function dedupeRefreshes(history: Read[]): Refresh[] {
  const reads = [...history]
    .filter((r) => Number.isFinite(r.players_tracked) && r.players_tracked > 0 && Array.isArray(r.rates))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const out: Refresh[] = [];
  const seen = new Set<string>();
  let currentKey = '';
  let lastSeenHours = -Infinity;
  for (const r of reads) {
    const key = `${r.players_tracked}|${r.rates.join(',')}`;
    const h = hoursOf(r.at);
    if (key === currentKey) {
      lastSeenHours = h;
      continue;
    }
    if (seen.has(key)) continue; // a stale cache served an older page again
    const refreshHours = out.length === 0 ? h : (lastSeenHours + h) / 2;
    out.push({ hours: refreshHours, firstSeenHours: h, players: r.players_tracked, rates: r.rates });
    seen.add(key);
    currentKey = key;
    lastSeenHours = h;
  }
  return out;
}

/** Earners of every trophy at one refresh: rate / 100 x players tracked (NaN where the read lacked the trophy). */
function toEarnerCounts(refresh: Refresh): number[] {
  return refresh.rates.map((r) => (r === null || !Number.isFinite(r) ? NaN : (r / 100) * refresh.players));
}

/** Median gap between recent refreshes after launch, in hours (how stale the page is, on average, at any moment). */
function estimateRefreshCadence(refreshes: Refresh[]): number {
  const times = refreshes.filter((r) => r.hours > 0.5).map((r) => r.firstSeenHours);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  if (gaps.length === 0) return 1;
  return clamp(median(gaps.slice(-24)), 0.1, 12);
}

// ---------------------------------------------------------------------------------------------------------------------
// Slopes in log-time

/** Everything the extrapolation needs, measured at the last refresh of a (possibly cut) history. */
interface Slopes {
  uNow: number;
  lnPlayers: number;
  playersSlope: number;
  rates: number[];
  earners: number[];
  earnersSlope: number[]; // d ln(earners + 0.5) / du, shrunk
  logitSlope: number[]; // d logit(rate) / du, shrunk
}

/** A smooth curve of slope against logit rate across trophies, used to steady the slopes of thin trophies. */
function crossSectionalCurve(xs: number[], slopes: number[], ws: number[]): (x: number) => number {
  const keep = xs.map((_, i) => i).filter((i) => ws[i] > 0 && Number.isFinite(slopes[i]));
  if (keep.length < 4) {
    const m = keep.length > 0 ? median(keep.map((i) => slopes[i])) : 0;
    return () => Math.max(0, m);
  }
  const kx = keep.map((i) => xs[i]);
  const coef =
    weightedLeastSquares(
      keep.map((i) => [1, xs[i], xs[i] * xs[i]]),
      keep.map((i) => slopes[i]),
      keep.map((i) => ws[i]),
      [0, 0.01, 0.2],
    ) ?? [median(keep.map((i) => slopes[i])), 0, 0];
  const lo = Math.min(...kx);
  const hi = Math.max(...kx);
  return (x) => {
    const c = clamp(x, lo, hi);
    return Math.max(0, coef[0] + coef[1] * c + coef[2] * c * c);
  };
}

/** Recent log-time slopes of ln players, ln earners and logit rate, from the refreshes up to the cut. */
function measureSlopes(fit: Refresh[], nTrophies: number): Slopes {
  const last = fit[fit.length - 1];
  const us = fit.map((r) => logTime(r.hours));
  const uNow = us[us.length - 1];
  let start = us.findIndex((u) => u >= uNow - PARAMS.slopeWindowU);
  start = Math.max(0, Math.min(start, us.length - PARAMS.minWindowPoints));
  const win = fit.slice(start);
  const wu = us.slice(start);
  const ones = wu.map(() => 1);
  const playersSlope = Math.max(0, weightedSlope(wu, win.map((r) => Math.log(r.players)), ones));
  const counts = win.map(toEarnerCounts);
  const rates = fit[fit.length - 1].rates.map((r) => (r === null || !Number.isFinite(r) ? 0 : r));
  const earners = rates.map((r) => (r / 100) * last.players);
  const ownE: number[] = [];
  const ownG: number[] = [];
  for (let i = 0; i < nTrophies; i++) {
    const u: number[] = [];
    const yE: number[] = [];
    const yG: number[] = [];
    const wE: number[] = [];
    const wG: number[] = [];
    for (let k = 0; k < win.length; k++) {
      const e = counts[k][i];
      const r = win[k].rates[i];
      if (!Number.isFinite(e) || r === null) continue;
      // The page rounds to 2 decimals: an earner count is known to +-0.005% of players.
      const roundSd = (win[k].players * 5e-5) / Math.sqrt(3);
      const sdE = roundSd / (e + 0.5) + 0.005;
      const p = clampPct(r) / 100;
      const sdG = 5e-5 / Math.sqrt(3) / (p * (1 - p)) + 0.005;
      u.push(wu[k]);
      yE.push(Math.log(e + 0.5));
      yG.push(logit(r));
      wE.push(1 / (sdE * sdE));
      wG.push(1 / (sdG * sdG));
    }
    ownE.push(u.length >= 2 ? Math.max(0, weightedSlope(u, yE, wE)) : 0);
    ownG.push(u.length >= 2 ? weightedSlope(u, yG, wG) : 0);
  }
  const xs = rates.map(logit);
  const trust = earners.map((e, i) => (rates[i] >= 99.5 ? 0 : e / (e + PARAMS.shrinkEarners)));
  const curveE = crossSectionalCurve(xs, ownE, trust.map((t, i) => (earners[i] >= 3 ? t : 0)));
  const curveG = crossSectionalCurve(xs, ownG, trust.map((t, i) => (earners[i] >= 3 ? t : 0)));
  return {
    uNow,
    lnPlayers: Math.log(last.players),
    playersSlope,
    rates,
    earners,
    earnersSlope: ownE.map((s, i) => trust[i] * s + (1 - trust[i]) * curveE(xs[i])),
    logitSlope: ownG.map((s, i) => trust[i] * s + (1 - trust[i]) * curveG(xs[i])),
  };
}

/** players_tracked at the target, in ln: today's log-time slope, decaying. */
function forecastPlayersTracked(s: Slopes, du: number, decay: number): number {
  return s.lnPlayers + s.playersSlope * decayedGrowth(decay, du);
}

/** Each trophy's logit rate at the target: decayed earner growth over decayed player growth, logit trend near saturation. */
function forecastEarners(s: Slopes, du: number, earnersDecay: number, playersDecay: number): number[] {
  const lnP = forecastPlayersTracked(s, du, playersDecay);
  const g = decayedGrowth(earnersDecay, du);
  return s.rates.map((rate, i) => {
    if (rate >= 100) return logit(100);
    const lnE = Math.log(s.earners[i] + 0.5) + s.earnersSlope[i] * g;
    const earners = Math.max(s.earners[i], Math.exp(lnE) - 0.5);
    const countsPath = logit((100 * earners) / Math.exp(lnP));
    const logitPath = logit(rate) + s.logitSlope[i] * g;
    const w = clamp(1 - rate / PARAMS.countsRateCap, 0, 1);
    const floor = logit((100 * s.earners[i]) / Math.exp(lnP)); // earners never fall
    return Math.min(logit(99.99), Math.max(floor, w * countsPath + (1 - w) * logitPath));
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Story order

/** Ordered chains of trophies whose rates cannot cross: Chapter 1 >= 2 >= ... >= the final mission. */
function storyChains(trophies: Trophy[]): number[][] {
  const chapters: Array<[number, number]> = [];
  let finalMission = -1;
  trophies.forEach((t, i) => {
    const m = /^Complete Chapter (\d+)\.?$/i.exec(t.description.trim());
    if (m) chapters.push([Number(m[1]), i]);
    if (/^Complete the final mission\.?$/i.test(t.description.trim())) finalMission = i;
  });
  chapters.sort((a, b) => a[0] - b[0]);
  const chain = chapters.map(([, i]) => i);
  if (finalMission >= 0) chain.push(finalMission);
  return chain.length >= 2 ? [chain] : [];
}

/** Pool-adjacent-violators: the closest non-increasing sequence (equal weights) to xs. */
function nonIncreasing(xs: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const x of xs) {
    blocks.push({ sum: x, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => new Array<number>(b.n).fill(b.sum / b.n));
}

/** Story chapters never exceed earlier ones and the platinum never exceeds any trophy (per column of logits). */
function enforceStoryOrder(values: number[], trophies: Trophy[]): number[] {
  const out = [...values];
  for (const chain of storyChains(trophies)) {
    const fixed = nonIncreasing(chain.map((i) => out[i]));
    chain.forEach((i, k) => (out[i] = fixed[k]));
  }
  const plat = trophies.findIndex((t) => t.tier === 'platinum');
  if (plat >= 0) {
    const others = out.filter((_, i) => i !== plat);
    if (others.length > 0) out[plat] = Math.min(out[plat], Math.min(...others));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// In-case pseudo-forecasts: choose the decays and calibrate the quantiles

/** The page at a moment: the last refresh first seen at or before it. */
function stateAt(refreshes: Refresh[], hours: number): Refresh {
  let s = refreshes[0];
  for (const r of refreshes) if (r.firstSeenHours <= hours) s = r;
  return s;
}

const fitRefreshes = (refreshes: Refresh[]): Refresh[] => refreshes.filter((r) => r.hours >= PARAMS.firstFitHours);
const hasEnoughHistory = (fit: Refresh[]): boolean => fit.length >= 3 && fit[fit.length - 1].hours - fit[0].hours >= 2;

interface PseudoCut {
  slopes: Slopes;
  du: number; // pseudo horizon in log-time
  weight: number;
  lastRates: number[];
  answerRates: Array<number | null>;
  answerPlayers: number;
  known: Refresh[];
}

/** Cuts inside the history, each forecasting a later refresh about the real log-time horizon ahead. */
function pseudoCuts(refreshes: Refresh[], duReal: number, cadence: number, nTrophies: number): PseudoCut[] {
  const out: PseudoCut[] = [];
  const last = refreshes[refreshes.length - 1];
  if (fitRefreshes(refreshes).length < 6 || duReal <= 0) return out;
  const uLast = logTime(last.firstSeenHours);
  const hStart = Math.max(PARAMS.firstFitHours + 4, last.hours / 4);
  const step = Math.max(0.5, (last.hours - hStart) / 20);
  for (let hc = hStart; hc < last.hours; hc += step) {
    const known = refreshes.filter((r) => r.firstSeenHours <= hc);
    const fit = fitRefreshes(known);
    if (!hasEnoughHistory(fit)) continue;
    const uc = logTime(hc);
    const uTarget = Math.min(uc + duReal, uLast);
    const answer = stateAt(refreshes, hoursOfLogTime(uTarget));
    if (answer === known[known.length - 1]) continue;
    const du = logTime(Math.max(fit[fit.length - 1].hours, hoursOfLogTime(uTarget) - cadence / 2)) - logTime(fit[fit.length - 1].hours);
    if (uTarget - uc < PARAMS.minPseudoShare * duReal || du <= 0) continue;
    const slopes = measureSlopes(fit, nTrophies);
    out.push({ slopes, du, weight: (uTarget - uc) / duReal, lastRates: slopes.rates, answerRates: answer.rates, answerPlayers: answer.players, known });
  }
  return out;
}

/** The decay with the least weighted error over the cuts, pulled toward the prior. */
function chooseDecay(errorOf: (decay: number) => number, prior: number): number {
  let best = prior;
  let bestScore = Infinity;
  for (const d of DECAY_GRID) {
    const score = errorOf(d) + PARAMS.decayPenalty * Math.log((d + 0.25) / (prior + 0.25)) ** 2;
    if (score < bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

interface Decays {
  players: number;
  earners: number;
}

function chooseDecays(cuts: PseudoCut[]): Decays {
  if (cuts.length < 2) return { players: PARAMS.playersDecayPrior, earners: PARAMS.earnersDecayPrior };
  const wsum = cuts.reduce((s, c) => s + c.weight, 0);
  const players = chooseDecay(
    (d) => cuts.reduce((s, c) => s + c.weight * Math.abs(forecastPlayersTracked(c.slopes, c.du, d) - Math.log(c.answerPlayers)), 0) / wsum,
    PARAMS.playersDecayPrior,
  );
  const earners = chooseDecay((d) => {
    let err = 0;
    let n = 0;
    for (const c of cuts) {
      const m = forecastEarners(c.slopes, c.du, d, players);
      c.answerRates.forEach((y, i) => {
        if (y === null) return;
        err += c.weight * Math.abs(logit(y) - m[i]);
        n += c.weight;
      });
    }
    return n > 0 ? err / n : 0;
  }, PARAMS.earnersDecayPrior);
  return { players, earners };
}

function rateBand(rate: number): number {
  if (rate < 1) return 0;
  if (rate < 10) return 1;
  if (rate < 60) return 2;
  return 3;
}

interface Calibration {
  bias: number[]; // per band
  offsets: number[][]; // per band, per level: logit offset from the median
  cuts: number;
}

/** Quantile offsets by rate band from the pseudo-forecast residuals, scaled to the real log-time horizon. */
function calibrateQuantiles(cuts: PseudoCut[], decays: Decays, trophies: Trophy[], duReal: number): Calibration {
  const residuals: Array<{ band: number; e: number; w: number }> = [];
  for (const c of cuts) {
    const m = enforceStoryOrder(forecastEarners(c.slopes, c.du, decays.earners, decays.players), trophies);
    const scale = (duReal / Math.max(c.du, 1e-3)) ** PARAMS.horizonPower;
    c.answerRates.forEach((y, i) => {
      if (y === null || !Number.isFinite(y)) return;
      residuals.push({ band: rateBand(c.lastRates[i]), e: (logit(y) - m[i]) * scale, w: c.weight });
    });
  }
  const sigmaPrior = PARAMS.sigmaPriorBase + PARAMS.sigmaPriorPerU * duReal;
  const wEmp = cuts.length / (cuts.length + PARAMS.priorCuts);
  const bias: number[] = [];
  const offsets: number[][] = [];
  for (let b = 0; b < 4; b++) {
    let pick = residuals.filter((r) => r.band === b);
    if (pick.length < 12) pick = residuals;
    if (pick.length < 12) {
      bias.push(0);
      offsets.push(Z.map((z) => z * sigmaPrior));
      continue;
    }
    const es = pick.map((r) => r.e);
    const ws = pick.map((r) => r.w);
    const mid = weightedQuantile(es, ws, 0.5);
    bias.push(PARAMS.biasShare * mid * wEmp);
    offsets.push(LEVELS.map((t, j) => wEmp * (weightedQuantile(es, ws, t) - mid) + (1 - wEmp) * Z[j] * sigmaPrior));
  }
  if (DEBUG) {
    console.error(`  calibration: ${cuts.length} cuts, ${residuals.length} residuals, bias ${bias.map((b) => b.toFixed(2)).join(' ')}`);
    offsets.forEach((o, b) => console.error(`   band ${b}: ${o.map((x) => x.toFixed(2)).join(' ')}`));
  }
  return { bias, offsets, cuts: cuts.length };
}

/** Five quantiles per trophy: median + band offsets, floored, widened for rare trophies, in percent. */
function buildQuantiles(medians: number[], lastRates: number[], cal: Calibration, duReal: number): number[][] {
  const floor = PARAMS.sigmaFloorBase + PARAMS.sigmaFloorPerU * duReal;
  return medians.map((m, i) => {
    const rate = lastRates[i];
    const band = rateBand(rate);
    const center = m + cal.bias[band];
    const widen = rate < 1 ? 1 + PARAMS.rareWiden * (1 + clamp(-Math.log10(Math.max(rate, 0.01)), 0, 2) / 2) : 1;
    return cal.offsets[band].map((o, j) => {
      const sized = Z[j] === 0 ? 0 : Math.sign(Z[j]) * Math.max(Math.abs(o), floor * Math.abs(Z[j]));
      return center + sized * widen;
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Case -> rows, with the baseline as fallback

function persistenceBaseline(c: Case): Row[] {
  const last = c.history[c.history.length - 1];
  const spread = 0.5 * Math.sqrt(Math.max(0, c.horizon_minutes) / 1440);
  return c.trophies.map((t, i) => {
    const l = logit(last?.rates?.[i] ?? 0);
    return { id: t.id, q: Z.map((z) => round4(fromLogit(l + z * spread))) };
  });
}

/** Logit quantile columns for a case: the model's, or persistence-leaning ones when the history is short. */
function forecastLogitQuantiles(c: Case): { columns: number[][]; lastRates: number[] } {
  const refreshes = dedupeRefreshes(c.history);
  if (refreshes.length === 0) throw new Error('no usable reads');
  const cadence = estimateRefreshCadence(refreshes);
  const last = refreshes[refreshes.length - 1];
  const lastRates = c.trophies.map((_, i) => last.rates[i] ?? 0);
  const persistence = lastRates.map(logit);
  const targetHours = Math.max(last.hours, hoursOf(c.target) - cadence / 2);
  const fit = fitRefreshes(refreshes);
  const duReal = Math.max(0.005, logTime(targetHours) - logTime(last.hours));
  let medians: number[];
  let cal: Calibration;
  if (!hasEnoughHistory(fit)) {
    // Too little history: persistence, diluted when no post-launch refresh has been seen yet, with the prior spread.
    const shift = refreshes.some((r) => r.hours > 0.5) ? 0 : PARAMS.shortShift;
    medians = persistence.map((l, i) => (lastRates[i] >= 100 ? l : l + shift));
    cal = calibrateQuantiles([], { players: 0, earners: 0 }, c.trophies, duReal);
  } else {
    const cuts = pseudoCuts(refreshes, duReal, cadence, c.trophies.length);
    const decays = chooseDecays(cuts);
    const slopes = measureSlopes(fit, c.trophies.length);
    const model = forecastEarners(slopes, logTime(targetHours) - slopes.uNow, decays.earners, decays.players);
    // Lean toward persistence while the fitted history is short.
    const trust = clamp((fit.length - 2) / 6, 0, 1) * clamp((last.hours - fit[0].hours) / 12, 0.3, 1);
    medians = model.map((m, i) => trust * m + (1 - trust) * persistence[i]);
    cal = calibrateQuantiles(cuts, decays, c.trophies, duReal);
    if (DEBUG) {
      const lnP = forecastPlayersTracked(slopes, logTime(targetHours) - slopes.uNow, decays.players);
      console.error(
        `${c.id}: ${refreshes.length} refreshes, cadence ${cadence.toFixed(2)} h, du ${duReal.toFixed(3)}, players ${last.players} -> ${Math.exp(lnP).toFixed(0)} (slope ${slopes.playersSlope.toFixed(2)}), decays P ${decays.players} E ${decays.earners}, trust ${trust.toFixed(2)}`,
      );
    }
  }
  medians = enforceStoryOrder(medians, c.trophies);
  const quantiles = buildQuantiles(medians, lastRates, cal, duReal);
  // Story order per quantile column too, so no chapter's band sits above an earlier chapter's.
  const columns = LEVELS.map((_, j) => enforceStoryOrder(quantiles.map((q) => q[j]), c.trophies));
  return { columns, lastRates };
}

function forecastCase(c: Case): Row[] {
  const { columns, lastRates } = forecastLogitQuantiles(c);
  return c.trophies.map((t, i) => {
    let q = columns.map((col) => (lastRates[i] >= 100 && col[i] >= logit(99.99) ? 100 : fromLogit(col[i])));
    q = q.map((x) => round4(clamp(x, 0, 100)));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
}

function validRows(rows: Row[], c: Case): boolean {
  if (rows.length !== c.trophies.length) return false;
  const ids = new Set(rows.map((r) => r.id));
  if (ids.size !== rows.length || c.trophies.some((t) => !ids.has(t.id))) return false;
  return rows.every(
    (r) => r.q.length === 5 && r.q.every((x, j) => Number.isFinite(x) && x >= 0 && x <= 100 && (j === 0 || x >= r.q[j - 1])),
  );
}

function writeForecast(id: string, rows: Row[]): void {
  const text = `${JSON.stringify({ trophies: rows.map((r) => ({ id: r.id, q: r.q })) })}\n`;
  if (Buffer.byteLength(text) > 65_536) throw new Error('forecast too large');
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), text);
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const files = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of files) {
    const id = file.slice(0, -'.in'.length);
    let c: Case;
    try {
      c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    } catch (err) {
      console.error(`${file}: unreadable case (${String(err)})`);
      continue;
    }
    let rows: Row[];
    try {
      rows = forecastCase(c);
      if (!validRows(rows, c)) throw new Error('invalid rows');
    } catch (err) {
      console.error(`${file}: falling back to persistence (${err instanceof Error ? err.message : String(err)})`);
      rows = persistenceBaseline(c);
    }
    writeForecast(id, rows);
  }
}

main();

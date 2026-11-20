// GTA VI trophy earn-rate forecaster for make.fun's gta6-trophy-rarity-forecast-01 (Node 22, standard library only).
//
// The page's rate is earners / players_tracked, and both only move when Exophase refreshes the game. So:
//   1. dedupeRefreshes      collapse the house's reads into the distinct refreshes Exophase made;
//   2. toEarnerCounts       turn each rate back into an earner count (rate x players tracked);
//   3. forecastPlayersTracked / forecastEarners
//                           extrapolate ln(players) and ln(earners) in log-time, ln(1 + hours since launch), with
//                           damped slopes (growth saturates), and divide; a logit-trend and persistence ride along;
//   4. refresh cadence      the answer is the last refresh before the target, so forecast for that moment;
//   5. calibrateQuantiles   re-run every model from earlier cut points inside the history ("pseudo-forecasts"), weight
//                           the models by how well they did, and take the spread from their residuals, scaled to the
//                           target's log-time horizon;
//   6. enforceStoryOrder    a later chapter is never earned by more players than an earlier one; platinum is the rarest;
//   7. writeForecast        rounded, clamped, non-decreasing rows. Any error falls back to the house persistence row.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.6448536, -0.6744898, 0, 0.6744898, 1.6448536];
/** The clock the house's curve baseline uses: hours since 2026-11-19T00:00:00Z. */
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');

interface Trophy { id: number; name?: string; description?: string; tier?: string }
interface Read { at: string; slot?: string; players_tracked: number; rates: Array<number | null> }
interface Case { id?: string; at: string; target: string; horizon_minutes: number; levels: number[]; trophies: Trophy[]; history: Read[] }
interface Refresh { h: number; seenH: number; players: number; rates: Array<number | null> }
interface Row { id: number; q: number[] }

/** Tunable numbers. FORECAST_PARAMS (JSON) overrides them for the backtest only; the grader never sets it. */
const PARAMS = {
  minTrendHours: 4,       // refreshes before this are the launch-night tester page, a different regime
  spanMin: 0.6,           // log-time span of the fit window, at least ...
  spanMax: 1.2,           // ... and at most
  recency: 0.5,           // recency weighting of the fit, in log-time units
  dampLogit: 0.6,         // share of the fitted logit slope carried forward
  dampEarners: 0.7,       // share of the earners' / non-earners' extrapolated change kept
  priorPersist: 0.1,
  priorLogit: 0.3,
  priorCounts: 0.3,
  priorDecay: 0.3,
  priorAnalog: 0.5,
  analogWindow: 0.5,      // log-time span of the recent path a donor must match
  analogMaxShift: 2.6,    // the largest log-time lag a donor may run ahead by
  analogOffsetCost: 0.3,  // penalty per logit unit of level offset between trophy and donor
  analogTop: 8,           // matches averaged
  analogMaxScore: 0.6,    // no donor this good: no analog forecast
  halfMin: 0.25,          // half-window of the slope-decay fit, in log-time units
  halfMax: 0.6,
  kappaPrior: -0.7,       // slope decay per unit log-time when the history cannot say
  kappaMax: 0,            // slopes may hold but not keep speeding up (acceleration extrapolated overshoots)
  kappaShrink: 1,         // pull of the pooled decay on each series' own
  weightTemp: 0.12,       // softness of the pseudo-forecast model weighting (logit units)
  spreadPrior: 0.45,      // logit sd per unit of log-time horizon when the history says little
  spreadExp: 0.75,        // residuals scale as (horizon ratio)^spreadExp
  priorResiduals: 60,     // pseudo-residuals worth as much as the prior spread
  ownWeight: 1,           // weight of a trophy's own residual scale against the pooled one
  rareBoost: 0.3,         // extra spread per logit unit below -4 (rare trophies surprise most)
  tailBoost: 1.1,         // widen the 5% / 95% quantiles a little (fat tails)
  biasShrink: 0,          // share of the pseudo-forecast median bias corrected (it does not carry over: none)
  spreadScale: 0.75,      // overall width of the band (the backtest's best is ~0.6; kept wider for real surprises)
  minRefreshesForTrend: 3,
  cutMin: 0.25,           // pseudo-forecast horizons, as shares of the real one
  cutMax: 1.6,
  ...(process.env.FORECAST_PARAMS ? (JSON.parse(process.env.FORECAST_PARAMS) as Record<string, number>) : {}),
};

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => { const c = clampPct(pct); return Math.log(c / (100 - c)); };
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const hoursOf = (iso: string): number => (Date.parse(iso) - LAUNCH_MS) / 3_600_000;
const logTime = (h: number): number => Math.log(1 + Math.max(0, h));
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** A trophy's latest finite rate in the history (a read may lack it or carry junk); 0 when none has one. */
function lastFiniteRate(history: Read[], i: number): number {
  for (let k = history.length - 1; k >= 0; k--) {
    const v = history[k]?.rates?.[i];
    if (typeof v === 'number' && Number.isFinite(v)) return clamp(v, 0, 100);
  }
  return 0;
}

/** The house persistence row: last rate, random-walk spread 0.5 * sqrt(days) on the logit scale. */
function persistenceRows(c: Case): Row[] {
  const minutes = Number.isFinite(c.horizon_minutes) ? Math.max(0, c.horizon_minutes) : 6510;
  const spread = 0.5 * Math.sqrt(minutes / 1440);
  return c.trophies.map((t, i) => {
    const l = logit(lastFiniteRate(c.history ?? [], i));
    return { id: t.id, q: [-1.645, -0.674, 0, 0.674, 1.645].map((z) => round4(fromLogit(l + z * spread))) };
  });
}

/** One entry per distinct page state Exophase served, oldest first. A refresh is dated halfway between the last read
 *  that still showed the old state and the first that showed the new one. A state that comes back after another one
 *  (a stale cache) or that shows fewer players than an earlier refresh is dropped. */
function dedupeRefreshes(history: Read[]): Refresh[] {
  const out: Refresh[] = [];
  const seen = new Set<string>();
  let prevKey = '';
  let prevH = NaN;
  let maxPlayers = 0;
  for (const r of history) {
    const h = hoursOf(r?.at);
    if (!Number.isFinite(h) || typeof r.players_tracked !== 'number' || !(r.players_tracked > 0) || !Array.isArray(r.rates)) continue;
    const key = `${r.players_tracked}|${r.rates.join(',')}`;
    if (key !== prevKey && !seen.has(key) && r.players_tracked >= maxPlayers) {
      const start = Number.isFinite(prevH) ? (prevH + h) / 2 : h;
      // Junk becomes missing; a missing rate carries forward from the refresh before.
      const before = out[out.length - 1];
      const rates = r.rates.map((v, i) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 100) : before?.rates[i] ?? null));
      out.push({ h: start, seenH: h, players: r.players_tracked, rates });
      seen.add(key);
      maxPlayers = r.players_tracked;
    }
    if (key !== prevKey) prevKey = key;
    prevH = h;
  }
  return out;
}

/** earners[k][i] = rate x players / 100 for refresh k and trophy i (NaN where the read lacked the trophy). */
function toEarnerCounts(refs: Refresh[], n: number): number[][] {
  return refs.map((r) => Array.from({ length: n }, (_, i) => {
    const v = r.rates[i];
    return v === null || v === undefined || !Number.isFinite(v) ? NaN : (v / 100) * r.players;
  }));
}

/** When the answering page was refreshed: the last refresh at or before the target, from the refreshes' cadence. */
function effectiveTargetHours(refs: Refresh[], hTarget: number, minHours: number): number {
  const late = refs.filter((r) => r.h >= minHours);
  const last = refs[refs.length - 1];
  if (late.length < 3) return hTarget;
  const gaps: number[] = [];
  for (let k = 1; k < late.length; k++) gaps.push(late[k].h - late[k - 1].h);
  const recent = gaps.slice(-8);
  const g = median(recent);
  if (!(g > 0)) return hTarget;
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const sd = Math.sqrt(recent.reduce((a, b) => a + (b - mean) ** 2, 0) / recent.length);
  const regular = sd / mean < 0.25;
  const eff = regular ? last.h + Math.floor((hTarget - last.h) / g) * g : hTarget - g / 2;
  return clamp(eff, last.h, hTarget);
}

/** Weighted least-squares slope of ys on xs. */
function weightedSlope(xs: number[], ys: number[], ws: number[]): number {
  let sw = 0, sx = 0, sy = 0;
  for (let k = 0; k < xs.length; k++) { sw += ws[k]; sx += ws[k] * xs[k]; sy += ws[k] * ys[k]; }
  if (sw <= 0) return 0;
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let k = 0; k < xs.length; k++) { sxx += ws[k] * (xs[k] - mx) ** 2; sxy += ws[k] * (xs[k] - mx) * (ys[k] - my); }
  return sxx > 1e-12 ? sxy / sxx : 0;
}

/** The refreshes the trend models fit: the trailing log-time window before the last one (at least 3 refreshes). */
function fitWindow(refs: Refresh[], horizon: number): number[] {
  const usable: number[] = [];
  refs.forEach((r, k) => { if (r.h >= PARAMS.minTrendHours) usable.push(k); });
  if (usable.length === 0) return [];
  const xLast = logTime(refs[usable[usable.length - 1]].h);
  const span = clamp(horizon, PARAMS.spanMin, PARAMS.spanMax);
  let win = usable.filter((k) => logTime(refs[k].h) >= xLast - span);
  if (win.length < 3) win = usable.slice(-3);
  return win;
}

/** A series' log-time slope in its latest half-window and the one before it. kappa is how fast the slope decays per
 *  unit of log-time (negative: slowing down, positive: speeding up); NaN when either half has too few refreshes. */
interface SlopeFit { late: number; kappa: number; weight: number }
function slopeHalves(xs: number[], ys: number[], xLast: number, half: number): SlopeFit {
  const lateIdx: number[] = [], earlyIdx: number[] = [];
  xs.forEach((x, k) => {
    if (x >= xLast - half) lateIdx.push(k);
    else if (x >= xLast - 2 * half) earlyIdx.push(k);
  });
  const fit = (idx: number[]): number => weightedSlope(idx.map((k) => xs[k]), idx.map((k) => ys[k]), idx.map(() => 1));
  let lateSet = lateIdx;
  if (lateSet.length < 2) lateSet = xs.map((_, k) => k).slice(-2);
  const late = lateSet.length >= 2 ? fit(lateSet) : 0;
  if (earlyIdx.length < 2 || lateIdx.length < 2) return { late, kappa: NaN, weight: 0 };
  const early = fit([...earlyIdx, lateIdx[0]]);
  if (Math.abs(early) < 1e-6 || Math.sign(early) !== Math.sign(late) || Math.abs(late) < 1e-6) {
    return { late, kappa: Math.sign(late) === Math.sign(early) ? NaN : -2, weight: Math.abs(late) + Math.abs(early) };
  }
  return { late, kappa: clamp(Math.log(late / early) / half, -3, 1.5), weight: Math.abs(late) };
}

/** The pooled decay: a weighted median of the series' kappas, falling back to the prior. */
function pooledKappa(fits: SlopeFit[]): number {
  const pts = fits.filter((f) => Number.isFinite(f.kappa) && f.weight > 0).sort((a, b) => a.kappa - b.kappa);
  const total = pts.reduce((a, f) => a + f.weight, 0);
  if (pts.length < 3 || total <= 0) return PARAMS.kappaPrior;
  let acc = 0;
  for (const f of pts) { acc += f.weight; if (acc >= total / 2) return clamp(f.kappa, -3, PARAMS.kappaMax); }
  return PARAMS.kappaPrior;
}

/** Change of a series over `horizon` log-time units: its latest slope, moved to the window's end and decaying (or
 *  growing) at kappa per unit log-time, kappa shrunk from the series' own toward the pooled one. */
function extrapolate(fit: SlopeFit, pooled: number, half: number, horizon: number): number {
  const own = Number.isFinite(fit.kappa) ? fit.kappa : pooled;
  const kappa = clamp((own + PARAMS.kappaShrink * pooled) / (1 + PARAMS.kappaShrink), -3, PARAMS.kappaMax);
  const slopeEnd = fit.late * Math.exp((kappa * half) / 2);
  return Math.abs(kappa) < 1e-6 ? slopeEnd * horizon : (slopeEnd * (Math.exp(kappa * horizon) - 1)) / kappa;
}

/** Log-time series of a trophy over the window, as [xs, ys], skipping refreshes that lacked it. */
function seriesOf(refs: Refresh[], win: number[], value: (r: Refresh) => number): [number[], number[]] {
  const xs: number[] = [], ys: number[] = [];
  for (const k of win) {
    const v = value(refs[k]);
    if (Number.isFinite(v)) { xs.push(logTime(refs[k].h)); ys.push(v); }
  }
  return [xs, ys];
}

/** ln(players tracked at the target) - ln(players now), with its own learned slope decay; never negative. */
function forecastPlayersTracked(refs: Refresh[], win: number[], half: number, horizon: number): number {
  const [xs, ys] = seriesOf(refs, win, (r) => Math.log(Math.max(1, r.players)));
  if (xs.length < 2) return 0;
  const fit = slopeHalves(xs, ys, xs[xs.length - 1], half);
  const kappa = Number.isFinite(fit.kappa) ? Math.min(fit.kappa, 0) : PARAMS.kappaPrior;
  return Math.max(0, extrapolate({ ...fit, kappa }, kappa, half, horizon));
}

/** For each trophy, ln(earners) and ln(non-earners) at the target minus now. Earners never shrink; the logit of the
 *  rate is ln(earners) - ln(non-earners), so this saturates at 100% on its own. */
function forecastEarners(refs: Refresh[], earners: number[][], win: number[], half: number, horizon: number, n: number): Array<[number, number]> {
  // Half the smallest count the page can print (0.005% of players) keeps a 0% or 100% trophy's log finite.
  const floor = (r: Refresh): number => 0.00005 * r.players;
  const index = new Map(refs.map((r, k) => [r, k]));
  const fitsE: SlopeFit[] = [], fitsN: SlopeFit[] = [];
  for (let i = 0; i < n; i++) {
    const [xe, ye] = seriesOf(refs, win, (r) => Math.log(Math.max(earners[index.get(r) as number][i], floor(r))));
    const [xn, yn] = seriesOf(refs, win, (r) => Math.log(Math.max(r.players - earners[index.get(r) as number][i], floor(r))));
    fitsE.push(xe.length >= 2 ? slopeHalves(xe, ye, xe[xe.length - 1], half) : { late: 0, kappa: NaN, weight: 0 });
    fitsN.push(xn.length >= 2 ? slopeHalves(xn, yn, xn[xn.length - 1], half) : { late: 0, kappa: NaN, weight: 0 });
  }
  const kE = pooledKappa(fitsE), kN = pooledKappa(fitsN);
  return fitsE.map((f, i) => [Math.max(0, extrapolate(f, kE, half, horizon) * PARAMS.dampEarners), extrapolate(fitsN[i], kN, half, horizon) * PARAMS.dampEarners]);
}

/** Linear interpolation of a series (xs ascending) at x; NaN outside it. */
function interpolate(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0 || x < xs[0] - 1e-9 || x > xs[xs.length - 1] + 1e-9) return NaN;
  let lo = 0, hi = xs.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  if (xs[hi] === xs[lo]) return ys[lo];
  const t = clamp((x - xs[lo]) / (xs[hi] - xs[lo]), 0, 1);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Lagged analogs: a trophy that players reach later tends to follow, in log-time, the path an earlier trophy already
 *  took (reaching chapter k takes play-time roughly in proportion to how far into the story it is, and that ratio is
 *  a shift in log-time). For trophy i, find donors j and shifts delta >= horizon such that logit r_i(x) ~ logit
 *  r_j(x - delta) + a over i's recent window; the forecast is r_j(x_target - delta) + a, a point already observed.
 *  The best matches are averaged; NaN where no donor fits. */
function forecastByAnalogs(refs: Refresh[], horizon: number, n: number): number[] {
  const usable = refs.filter((r) => r.h >= PARAMS.minTrendHours);
  const out = new Array<number>(n).fill(NaN);
  if (usable.length < 4) return out;
  const xs = usable.map((r) => logTime(r.h));
  const xLast = xs[xs.length - 1];
  const series = Array.from({ length: n }, (_, i) => usable.map((r) => (r.rates[i] === null || r.rates[i] === undefined ? NaN : logit(r.rates[i] as number))));
  if (series.some((s) => s.some((v) => !Number.isFinite(v)))) return out;
  const winIdx = xs.map((x, k) => k).filter((k) => xs[k] >= xLast - PARAMS.analogWindow);
  if (winIdx.length < 3) return out;
  const xTarget = xLast + horizon;
  for (let i = 0; i < n; i++) {
    const yi = series[i];
    if (yi[yi.length - 1] > 8 || yi[yi.length - 1] < -9) continue; // at 100% or 0%: nothing to learn
    const matches: Array<{ score: number; value: number }> = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const yj = series[j];
      for (let delta = horizon; delta <= PARAMS.analogMaxShift; delta += 0.04) {
        if (xs[winIdx[0]] - delta < xs[0]) break;
        const value = interpolate(xs, yj, xTarget - delta);
        if (!Number.isFinite(value)) continue;
        let sum = 0;
        const diffs: number[] = [];
        for (const k of winIdx) {
          const d = yi[k] - interpolate(xs, yj, xs[k] - delta);
          diffs.push(d);
          sum += d;
        }
        const a = sum / diffs.length;
        const rmse = Math.sqrt(diffs.reduce((s, d) => s + (d - a) ** 2, 0) / diffs.length);
        matches.push({ score: rmse + PARAMS.analogOffsetCost * Math.abs(a), value: value + a });
      }
    }
    if (matches.length === 0) continue;
    matches.sort((p, q) => p.score - q.score);
    const top = matches.slice(0, PARAMS.analogTop);
    if (top[0].score > PARAMS.analogMaxScore) continue;
    let sw = 0, sv = 0;
    for (const m of top) { const w = Math.exp(-(m.score - top[0].score) / 0.05); sw += w; sv += w * m.value; }
    out[i] = sv / sw;
  }
  return out;
}

const MODELS = ['persist', 'logit', 'counts', 'decay', 'analog'] as const;
type ModelName = (typeof MODELS)[number];

/** Each model's forecast logit for every trophy, from refreshes[0..upto] to log-time horizon `horizon` past the last. */
function modelForecasts(refs: Refresh[], earners: number[][], upto: number, horizon: number, n: number): Record<ModelName, number[]> {
  const sub = refs.slice(0, upto + 1);
  const last = sub[sub.length - 1];
  const win = fitWindow(sub, horizon);
  const half = clamp(horizon / 2, PARAMS.halfMin, PARAMS.halfMax);
  // The decay model's window reaches two half-windows back.
  const usable = sub.map((_, k) => k).filter((k) => sub[k].h >= PARAMS.minTrendHours);
  const xEnd = logTime(last.h);
  const wide = usable.filter((k) => logTime(sub[k].h) >= xEnd - 2 * half);
  const persist: number[] = [];
  const logitTrend: number[] = [];
  const counts: number[] = [];
  const decay: number[] = [];
  const dP = forecastPlayersTracked(sub, wide, half, horizon);
  const dEN = forecastEarners(sub, earners, wide, half, horizon, n);
  const logitFits: SlopeFit[] = [];
  for (let i = 0; i < n; i++) {
    const [xs, ys] = seriesOf(sub, wide, (r) => (r.rates[i] === null || r.rates[i] === undefined ? NaN : logit(r.rates[i] as number)));
    logitFits.push(xs.length >= 2 ? slopeHalves(xs, ys, xs[xs.length - 1], half) : { late: 0, kappa: NaN, weight: 0 });
  }
  const kL = pooledKappa(logitFits);
  for (let i = 0; i < n; i++) {
    const r = last.rates[i];
    if (r === null || r === undefined || !Number.isFinite(r)) { persist.push(NaN); logitTrend.push(NaN); counts.push(NaN); decay.push(NaN); continue; }
    const l0 = logit(r);
    persist.push(l0);
    // Logit trend in log-time, a fixed share of the slope carried forward.
    const pts = win.filter((k) => Number.isFinite(sub[k].rates[i] as number));
    let dl = 0;
    if (pts.length >= 2) {
      const xs = pts.map((k) => logTime(sub[k].h));
      const ys = pts.map((k) => logit(sub[k].rates[i] as number));
      const xLast = xs[xs.length - 1];
      const ws = xs.map((x) => Math.exp(-(xLast - x) / PARAMS.recency));
      dl = clamp(weightedSlope(xs, ys, ws) * horizon * PARAMS.dampLogit, -4, 4);
    }
    logitTrend.push(l0 + dl);
    // Logit trend whose slope decays (or grows) at the rate the history shows.
    decay.push(l0 + clamp(extrapolate(logitFits[i], kL, half, horizon), -4, 4));
    // Counts: earners and non-earners (players - earners) separately; their log ratio is the logit.
    if (r >= 99.995) { counts.push(l0); continue; }
    const [dE, dN] = dEN[i];
    // Never fewer non-earners than the players' growth leaves room for, at the earners' current share.
    const p = clamp(r / 100, 1e-6, 1 - 1e-6);
    const e0 = Math.log(Math.max(p, 0.00005));
    const n0 = Math.log(Math.max(1 - p, 0.00005));
    const eT = e0 + dE;
    const nT = Math.max(n0 + dN, Math.log(Math.max(1e-9, Math.exp(dP) - Math.exp(eT))) - 0.0);
    counts.push(clamp(eT - nT, -9.21, 9.21));
  }
  // Where no donor fits, the analog model says what the logit trend says.
  const analog = forecastByAnalogs(sub, horizon, n).map((v, i) => (Number.isFinite(v) ? v : logitTrend[i]));
  return { persist, logit: logitTrend, counts, decay, analog };
}

/** Indices of the chains a trophy list implies: chapters in order, then the final mission, 100% completion and the
 *  platinum. Each chain's rates must not increase along it. Platinum also sits at or below every other trophy. */
function storyChains(trophies: Trophy[]): { chain: number[]; platinum: number } {
  const chapters: Array<[number, number]> = [];
  let finalMission = -1, completion = -1, platinum = -1;
  trophies.forEach((t, i) => {
    const d = (t.description ?? '').trim();
    const m = /^Complete Chapter (\d+)\.?$/i.exec(d);
    if (m) chapters.push([Number(m[1]), i]);
    else if (/^Complete the final mission\.?$/i.test(d)) finalMission = i;
    else if (/100% Completion/i.test(d)) completion = i;
    if ((t.tier ?? '').toLowerCase() === 'platinum') platinum = i;
  });
  chapters.sort((a, b) => a[0] - b[0]);
  const chain = chapters.map(([, i]) => i);
  if (finalMission >= 0) chain.push(finalMission);
  if (completion >= 0 && finalMission >= 0) chain.push(completion);
  return { chain, platinum };
}

/** Pool-adjacent-violators: the closest non-increasing sequence (least squares). */
function nonIncreasing(ys: number[]): number[] {
  const blocks: Array<{ sum: number; n: number }> = [];
  for (const y of ys) {
    blocks.push({ sum: y, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n) break;
      a.sum += b.sum; a.n += b.n; blocks.pop();
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let k = 0; k < b.n; k++) out.push(b.sum / b.n);
  return out;
}

/** Later chapters never above earlier ones; platinum never above any trophy. Works level by level on logits; isotonic
 *  regression preserves each row's order across levels. */
function enforceStoryOrder(q: number[][], trophies: Trophy[]): void {
  const { chain, platinum } = storyChains(trophies);
  for (let j = 0; j < 5; j++) {
    if (chain.length >= 2 && chain.every((i) => Number.isFinite(q[i][j]))) {
      const fixed = nonIncreasing(chain.map((i) => q[i][j]));
      chain.forEach((i, k) => { q[i][j] = fixed[k]; });
    }
    if (platinum >= 0) {
      let lo = Infinity;
      q.forEach((row, i) => { if (i !== platinum && Number.isFinite(row[j])) lo = Math.min(lo, row[j]); });
      if (Number.isFinite(lo)) q[platinum][j] = Math.min(q[platinum][j], lo);
    }
  }
  for (const row of q) row.sort((a, b) => a - b);
}

/** Pseudo-forecasts inside the history: model weights, the ensemble's median bias and its residual quantiles. */
function calibrateQuantiles(refs: Refresh[], earners: number[][], horizon: number, n: number) {
  const lastIdx = refs.length - 1;
  const xLast = logTime(refs[lastIdx].h);
  const first = refs.findIndex((r) => r.h >= PARAMS.minTrendHours);
  const preds: Array<{ scale: number; f: Record<ModelName, number[]>; actual: number[]; end: number }> = [];
  // Several distinct answering refreshes keep a single unusual refresh
  // from providing every residual used to pick models and size the band.
  for (const fraction of [0.45, 0.65, 0.82, 1]) {
    const desired = xLast - (1 - fraction) * Math.min(horizon, 1);
    let end = lastIdx;
    while (end > first && logTime(refs[end].h) > desired) end--;
    if (preds.some((p) => p.end === end)) continue;
    const endTime = logTime(refs[end].h);
    const actual = refs[end].rates.map((r) => (r == null ? NaN : logit(r)));
    const cuts: number[] = [];
    for (let k = first + PARAMS.minRefreshesForTrend - 1; k < end; k++) {
      const dp = endTime - logTime(refs[k].h);
      if (dp >= Math.max(0.05, PARAMS.cutMin * horizon) && dp <= PARAMS.cutMax * horizon) cuts.push(k);
    }
    const chosen = cuts.length <= 3 ? cuts : [cuts[0], cuts[Math.floor(cuts.length / 2)], cuts[cuts.length - 1]];
    for (const k of chosen) {
      const dp = endTime - logTime(refs[k].h);
      preds.push({ scale: Math.pow(horizon / dp, PARAMS.spreadExp), f: modelForecasts(refs, earners, k, dp, n), actual, end });
    }
  }
  const prior: Record<ModelName, number> = { persist: PARAMS.priorPersist, logit: PARAMS.priorLogit, counts: PARAMS.priorCounts, decay: PARAMS.priorDecay, analog: PARAMS.priorAnalog };
  const weights = { ...prior };
  if (preds.length > 0) {
    const loss: Record<string, number> = {};
    for (const m of MODELS) {
      let s = 0, c = 0;
      for (const p of preds) for (let i = 0; i < n; i++) {
        const e = p.actual[i] - p.f[m][i];
        if (Number.isFinite(e)) { s += Math.abs(e) * p.scale; c++; }
      }
      loss[m] = c ? s / c : Infinity;
    }
    const best = Math.min(...MODELS.map((m) => loss[m]));
    const endpoints = new Set(preds.map((p) => p.end)).size;
    const reliability = endpoints / (endpoints + 1);
    for (const m of MODELS) {
      const w = Number.isFinite(loss[m]) ? Math.exp(-(loss[m] - best) / PARAMS.weightTemp) : 0;
      weights[m] = (1 - reliability) * prior[m] + reliability * prior[m] * w;
    }
  }
  const total = MODELS.reduce((a, m) => a + weights[m], 0);
  for (const m of MODELS) weights[m] /= total;
  const blend = (f: Record<ModelName, number[]>, i: number): number => MODELS.reduce((a, m) => a + weights[m] * f[m][i], 0);
  const pooled: number[] = [];
  const own: number[][] = Array.from({ length: n }, () => []);
  for (const p of preds) for (let i = 0; i < n; i++) {
    const e = (p.actual[i] - blend(p.f, i)) * p.scale;
    if (Number.isFinite(e)) { pooled.push(e); own[i].push(e); }
  }
  return { weights, blend, pooled: pooled.sort((a, b) => a - b), own };
}

/** Quantile rows (percent) for one case. */
function coldStartForecast(c: Case, last: Refresh, baseline: Row[]): Row[] {
  const age = Math.max(0, hoursOf(c.at) - last.h);
  const hours = Math.max(0, c.horizon_minutes / 60);
  // Mix a page that stays cached with refreshes of varying size. Entrants
  // added by a refresh have had less time to earn the optional trophies.
  const arrivalRate = Math.max(0.15, Math.min(1.25, (age + hours) / 5));
  const scenarios = [
    { growth: 1, progress: 0, probability: 0.20 },
    { growth: 1 + 1.5 * arrivalRate, progress: 0.18, probability: 0.15 },
    { growth: 1 + 3 * arrivalRate, progress: 0.10, probability: 0.30 },
    { growth: 1 + 5 * arrivalRate, progress: 0.05, probability: 0.25 },
    { growth: 1 + 8 * arrivalRate, progress: 0.02, probability: 0.10 },
  ];
  return c.trophies.map((trophy, index) => {
    const rate = last.rates[index];
    if (rate == null) return baseline[index];
    const samples = scenarios.map(({ growth, progress, probability }) => {
      const p = rate / 100;
      const incumbentEarners = Math.round(p * last.players);
      const newcomerRate = p * (progress + (1 - progress) * p ** 2);
      const newPlayers = (growth - 1) * last.players;
      const rateAfterRefresh = 100 * (incumbentEarners + newPlayers * newcomerRate) / (last.players + newPlayers);
      return { value: growth === 1 ? rate : rateAfterRefresh, probability };
    }).sort((a, b) => a.value - b.value);
    return { id: trophy.id, q: LEVELS.map((level) => {
      let cumulative = 0;
      for (const sample of samples) {
        cumulative += sample.probability;
        if (cumulative >= level - 1e-9) return sample.value;
      }
      return samples[samples.length - 1].value;
    }) };
  });
}

function forecastCase(c: Case): Row[] {
  const n = c.trophies.length;
  const refs = dedupeRefreshes(c.history);
  if (refs.length === 0) throw new Error('no usable reads');
  const earners = toEarnerCounts(refs, n);
  const last = refs[refs.length - 1];
  const hTarget = hoursOf(c.target);
  const trendRefs = refs.filter((r) => r.h >= PARAMS.minTrendHours).length;
  const hEff = effectiveTargetHours(refs, hTarget, PARAMS.minTrendHours);
  const horizon = Math.max(0, logTime(hEff) - logTime(last.h));
  const baseRows = persistenceRows(c);

  if (refs.length === 1 && last.h <= 0 && hTarget > last.h && c.horizon_minutes <= 360) {
    return coldStartForecast(c, last, baseRows);
  }

  if (trendRefs < PARAMS.minRefreshesForTrend || horizon <= 0) {
    // Too little history to see a trend: persistence, with the spread at least the prior's.
    const s = Math.max(0.5 * Math.sqrt(c.horizon_minutes / 1440), PARAMS.spreadPrior * Math.max(horizon, logTime(hTarget) - logTime(last.h)));
    return c.trophies.map((t, i) => {
      const r = last.rates[i];
      if (r === null || r === undefined) return baseRows[i];
      return { id: t.id, q: Z.map((z) => fromLogit(logit(r) + z * s)) };
    });
  }

  const cal = calibrateQuantiles(refs, earners, horizon, n);
  const now = modelForecasts(refs, earners, refs.length - 1, horizon, n);
  if (process.env.FORECAST_DEBUG) {
    const pct = (l: number): string => fromLogit(l).toFixed(2).padStart(6);
    process.stderr.write(`${c.id}: ${refs.length} refreshes, horizon ${horizon.toFixed(3)} log-time, weights ${JSON.stringify(Object.fromEntries(MODELS.map((m) => [m, +cal.weights[m].toFixed(3)])))}\n`);
    for (let i = 0; i < n; i++) process.stderr.write(`  ${String(c.trophies[i].id).padStart(2)} last ${String(last.rates[i]).padStart(6)} ${MODELS.map((m) => `${m} ${pct(now[m][i])}`).join(' ')}\n`);
  }
  const pooled = cal.pooled;
  const nRes = pooled.length;
  const lam = nRes / (nRes + PARAMS.priorResiduals);
  const bias = nRes ? median(pooled) * PARAMS.biasShrink * lam : 0;
  const priorSd = PARAMS.spreadPrior * horizon;
  const pooledRms = nRes ? Math.sqrt(pooled.reduce((a, e) => a + e * e, 0) / nRes) : priorSd;
  // Offsets from the median at each level: empirical (centred) quantiles blended with a normal prior.
  const centre = nRes ? median(pooled) : 0;
  const offsets = Z.map((z, j) => {
    const emp = nRes ? quantile(pooled, LEVELS[j]) - centre : z * priorSd;
    return (lam * emp + (1 - lam) * z * priorSd) * PARAMS.spreadScale;
  });

  const q: number[][] = [];
  for (let i = 0; i < n; i++) {
    const r = last.rates[i];
    if (r === null || r === undefined || !Number.isFinite(r)) { q.push(baseRows[i].q.map(logit)); continue; }
    const m = cal.blend(now, i) + bias;
    if (!Number.isFinite(m)) { q.push(baseRows[i].q.map(logit)); continue; }
    // Every refresh at 100%: the opening trophy every tracked player has. Keep it there, with a thin lower tail.
    const allFull = refs.filter((x) => x.h >= PARAMS.minTrendHours).every((x) => (x.rates[i] ?? 0) >= 99.995);
    if (allFull) { q.push([logit(99.95), logit(99.99), logit(99.99), logit(99.99), 99]); continue; }
    const ownE = cal.own[i];
    const ownRms = ownE.length ? Math.sqrt(ownE.reduce((a, e) => a + e * e, 0) / ownE.length) : pooledRms;
    const k = PARAMS.ownWeight * ownE.length / (ownE.length + 3);
    let factor = pooledRms > 1e-9 ? Math.sqrt((k * ownRms ** 2 + pooledRms ** 2) / (k + 1)) / pooledRms : 1;
    factor *= 1 + PARAMS.rareBoost * Math.max(0, -4 - m);
    // Rounding to 2 decimals: a rate's last digit is worth this much logit near the target's rate.
    const p = clamp(fromLogit(m), 0.01, 99.99) / 100;
    const quant = 0.00005 / (p * (1 - p));
    q.push(offsets.map((o, j) => {
      const tail = j === 0 || j === 4 ? PARAMS.tailBoost : 1;
      const off = o * factor * tail;
      return m + Math.sign(off) * Math.sqrt(off * off + (Z[j] * quant) ** 2);
    }));
  }
  enforceStoryOrder(q, c.trophies);
  return c.trophies.map((t, i) => ({ id: t.id, q: q[i].map(fromLogit) }));
}

/** Round, clamp and order a case's rows; any row that is not five finite numbers takes the persistence row. */
function writeForecast(file: string, rows: Row[], fallback: Row[]): void {
  const clean = rows.map((row, i) => {
    let q = (row?.q ?? []).map((v) => round4(clamp(v, 0, 100)));
    if (q.length !== 5 || q.some((v) => !Number.isFinite(v))) q = fallback[i].q;
    if (q.length !== 5 || q.some((v) => !Number.isFinite(v))) q = [0, 0, 0, 0, 0];
    for (let j = 1; j < 5; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: fallback[i].id, q };
  });
  writeFileSync(file, `${JSON.stringify({ trophies: clean })}\n`);
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    const out = join(OUTPUT_DIR, `${id}.out`);
    let c: Case;
    try {
      c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    } catch (err) {
      process.stderr.write(`${file}: unreadable (${String(err)})\n`);
      continue;
    }
    let fallback: Row[];
    try {
      fallback = persistenceRows(c);
    } catch (err) {
      process.stderr.write(`${file}: no baseline possible (${String(err)})\n`);
      continue;
    }
    try {
      const rows = forecastCase(c);
      if (rows.length !== fallback.length) throw new Error('row count mismatch');
      writeForecast(out, rows, fallback);
    } catch (err) {
      process.stderr.write(`${file}: falling back to persistence (${String(err)})\n`);
      writeForecast(out, fallback, fallback);
    }
  }
}

main();

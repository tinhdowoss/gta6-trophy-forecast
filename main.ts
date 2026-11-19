// GTA VI trophy earn-rate forecaster for make.fun's gta6-trophy-rarity-forecast-01 (Node 22, standard library only).
//
// For each case it reads Exophase's page as the house recorded it and forecasts five quantiles of every trophy's earn
// rate at the case's target. The page only changes when Exophase refreshes its counts, so the history is first reduced
// to distinct refreshes, each dated to when it appeared. Every trophy's rate is earners / players tracked: the model
// forecasts the players tracked (growth in log-time, saturating) and each trophy's trend in logit(rate) against
// ln(hours since launch), shrunk toward a cross-trophy target so sparse rare trophies do not explode, then corrects the
// trend for the dilution change the players forecast implies. Several candidate forecasters (persistence among them)
// are backtested inside the case itself: cut the history at earlier refreshes, predict later ones at the same log-time
// horizon, and blend by how well each did. The same pseudo-forecast residuals, normalised to the target horizon and
// split by rate band, set the quantiles. Story order (Chapter N before Chapter N+1 before the final mission, platinum
// below every trophy) caps the late trophies. Any internal error falls back to the house persistence baseline.
//
//   mkdir -p out && MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = process.env.FORECAST_DEBUG === '1';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
const HOUR_MS = 3_600_000;

// ---- tunables (set by backtests on the synthetic launch-week simulator; never on the practice answers) ----
const TUNE = {
  RECENCY_L: 0.8, // e-folding of fit weights, in units of ln(1+hours)
  MIN_POST_LAUNCH_HOURS: 2, // refreshes before this are launch-night leftovers, not trend data
  LATENT_ZERO_PCT: 0.003, // a printed 0.00% is somewhere in [0, 0.005)
  DILUTION_RHO: 0.5, // new players bring a trophy at about this share of the current rate
  SELECTION_TEMP: 0.15, // softmax temperature on pseudo-forecast mean abs logit error
  SPREAD_INFLATE: 1.15, // extrapolating past the history's own horizons
  TE_RECONCILE: 0.5, // share of the trophies-earned implied common shift applied
  ZERO_PACE: 0.5, // a trophy never above 0.00% moves at this share of the growth curve's pace
  BIAS_SHARE: 0.25, // share of the pseudo-forecasts' median miss carried into the forecast
  SPREAD_PRIOR_ROWS: 150, // pseudo residual rows at which a band's empirical scale and the prior weigh the same
  GAMMA_PRIOR: 0.7, // slowing of the growth curve per unit log-time, before the case's own history speaks
};
// tools/backtest.ts may override tunables; the grader never sets this, so the defaults above are what is entered.
try { Object.assign(TUNE, JSON.parse(process.env.FORECAST_TUNE ?? '{}')); } catch { /* keep defaults */ }
const { RECENCY_L, MIN_POST_LAUNCH_HOURS, LATENT_ZERO_PCT, DILUTION_RHO, SELECTION_TEMP, SPREAD_INFLATE, TE_RECONCILE, ZERO_PACE, BIAS_SHARE, SPREAD_PRIOR_ROWS, GAMMA_PRIOR } = TUNE;

interface Trophy { id: number; name: string; description: string; tier: string; points: number; secret: boolean }
interface Read { slot?: string; at: string; players_tracked: number; trophies_earned?: number | null; rates: Array<number | null> }
interface Case { id?: string; at: string; target: string; horizon_minutes: number; levels: number[]; trophies: Trophy[]; history: Read[] }
interface State { tHours: number; x: number; players: number; earned: number | null; rates: Array<number | null> }
interface Row { id: number; q: number[] }

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
/** The scorer's logit: percent clamped to 0.01..99.99. */
const logit = (pct: number): number => { const p = clampPct(pct) / 100; return Math.log(p / (1 - p)); };
/** A logit that keeps a printed 0.00% / 100.00% apart from 0.01% / 99.99%, for fitting trends. */
const latentLogit = (pct: number): number => { const p = Math.min(100 - LATENT_ZERO_PCT, Math.max(LATENT_ZERO_PCT, pct)) / 100; return Math.log(p / (1 - p)); };
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
const timeX = (hours: number): number => Math.log(1 + Math.max(0, hours));
const hoursOf = (iso: string): number => (Date.parse(iso) - LAUNCH_MS) / HOUR_MS;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n === 0 ? NaN : n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const debug = (...a: unknown[]): void => { if (DEBUG) console.error(...a); };

// ------------------------------------------------------------------------------------------------------------------
// History → distinct Exophase refreshes
// ------------------------------------------------------------------------------------------------------------------

/**
 * Reduce the reads to the distinct states of the page, oldest first. A state is new when the players tracked or any
 * rate changed; it is dated halfway between the last read that still showed the previous state and the first read that
 * showed it. A state seen before (a cache flip-flop between two recorders) is ignored.
 */
function dedupeRefreshes(history: Read[], nTrophies: number): State[] {
  const reads = history
    .map((r, i) => ({ r, i, ms: Date.parse(r.at) }))
    .filter(({ r, ms }) => Number.isFinite(ms) && Number.isFinite(r.players_tracked) && r.players_tracked > 0 && Array.isArray(r.rates))
    .sort((a, b) => a.ms - b.ms || a.i - b.i);
  const seen = new Set<string>();
  const states: State[] = [];
  let prevMs: number | null = null;
  let lastKey = '';
  for (const { r, ms } of reads) {
    const rates = Array.from({ length: nTrophies }, (_, j) => {
      const v = r.rates[j];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
    });
    const key = `${r.players_tracked}|${rates.map((v) => (v === null ? 'n' : v)).join(',')}`;
    if (key !== lastKey && !seen.has(key)) {
      const refreshMs = prevMs === null ? ms : (prevMs + ms) / 2;
      const tHours = (refreshMs - LAUNCH_MS) / HOUR_MS;
      const earned = typeof r.trophies_earned === 'number' && Number.isFinite(r.trophies_earned) ? r.trophies_earned : null;
      states.push({ tHours, x: timeX(tHours), players: r.players_tracked, earned, rates });
      seen.add(key);
      lastKey = key;
    }
    prevMs = ms;
  }
  return states;
}

/**
 * Typical hours between Exophase refreshes: the median gap between post-launch refreshes, at least as long as the page
 * has now gone unchanged. Defaults to 6 h with too few refreshes.
 */
function estimateRefreshCadence(post: State[], lastReadHours: number): number {
  const gaps: number[] = [];
  for (let k = 1; k < post.length; k++) gaps.push(post[k].tHours - post[k - 1].tHours);
  let cadence = gaps.length >= 2 ? median(gaps) : 6;
  if (post.length > 0) cadence = Math.max(cadence, lastReadHours - post[post.length - 1].tHours);
  return Math.min(48, Math.max(0.5, cadence));
}

/** The time the answering page's counts are from: the last refresh before the target, on average half a cadence early. */
function effectiveTargetHours(targetHours: number, lastRefreshHours: number, cadence: number): number {
  if (targetHours - lastRefreshHours <= cadence / 2) return lastRefreshHours + (targetHours - lastRefreshHours) / 2;
  return Math.max(lastRefreshHours, targetHours - cadence / 2);
}

// ------------------------------------------------------------------------------------------------------------------
// Trend fitting
// ------------------------------------------------------------------------------------------------------------------

interface Line { a: number; b: number; varB: number; nEff: number }

/** Weighted least-squares line y = a + b x, with an approximate variance of the slope. */
function fitLogTimeTrend(xs: number[], ys: number[], ws: number[]): Line | null {
  let sw = 0, sww = 0, sx = 0, sy = 0;
  for (let k = 0; k < xs.length; k++) { sw += ws[k]; sww += ws[k] * ws[k]; sx += ws[k] * xs[k]; sy += ws[k] * ys[k]; }
  if (xs.length < 2 || sw <= 0) return null;
  const mx = sx / sw, my = sy / sw;
  let sxx = 0, sxy = 0;
  for (let k = 0; k < xs.length; k++) { sxx += ws[k] * (xs[k] - mx) ** 2; sxy += ws[k] * (xs[k] - mx) * (ys[k] - my); }
  if (sxx <= 1e-12) return null;
  const b = sxy / sxx, a = my - b * mx;
  const nEff = (sw * sw) / sww;
  let sse = 0;
  for (let k = 0; k < xs.length; k++) sse += ws[k] * (ys[k] - a - b * xs[k]) ** 2;
  const s2 = nEff > 2.05 ? (sse / sw) * nEff / (nEff - 2) : Infinity;
  // Floor the residual variance: rounding to 2 decimals and refresh noise never vanish.
  const varB = (Math.max(s2, 0.0004) / (sxx / sw)) / Math.max(nEff, 1);
  return { a, b, varB: Number.isFinite(varB) ? varB : Infinity, nEff };
}

/** Weighted quadratic fit y = c0 + c1 x + c2 x^2; returns the slope and curvature at x0, or null when ill-posed. */
function fitQuadraticAt(xs: number[], ys: number[], ws: number[], x0: number): { slope: number; curv: number } | null {
  if (xs.length < 4) return null;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
  for (let k = 0; k < xs.length; k++) {
    const d = xs[k] - x0, f = [1, d, d * d];
    for (let i = 0; i < 3; i++) { v[i] += ws[k] * f[i] * ys[k]; for (let j = 0; j < 3; j++) m[i][j] += ws[k] * f[i] * f[j]; }
  }
  const sol = solve3(m, v);
  if (!sol) return null;
  return { slope: sol[1], curv: 2 * sol[2] };
}

function solve3(m: number[][], v: number[]): number[] | null {
  const a = m.map((row, i) => [...row, v[i]]);
  const n = 3;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-10) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

/** Solve a small symmetric system by Gaussian elimination (ridge regressions across trophies). */
function solveN(m: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = m.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  return a.map((row, i) => row[n] / a[i][i]);
}

/** Weight of one observed rate in a logit fit: rounding to 0.01 points is large on the logit scale for rare trophies. */
function roundingWeight(pct: number): number {
  const p = Math.min(99.997, Math.max(LATENT_ZERO_PCT, pct));
  const sdLogit = 0.0029 / (p * (1 - p / 100)); // sd of the rounding error (0.01/sqrt(12) points), on the logit scale
  return 1 / (sdLogit * sdLogit + 0.02 * 0.02);
}

const recencyWeight = (x: number, xLast: number): number => Math.exp(-(xLast - x) / RECENCY_L);

interface Features { level: number; secret: number }

/**
 * Shrink each trophy's slope toward a cross-trophy target: a precision-weighted ridge regression of the slopes on the
 * trophy's current logit level (and its square) and whether it is secret (story) or not. The between-trophy variance
 * tau^2 is estimated by moments. Trophies with no usable slope (always 0.00%) get the target itself, kept within the
 * range of the slopes actually seen.
 */
function shrinkSlopes(slopes: Array<Line | null>, feats: Features[]): number[] {
  const n = slopes.length;
  const design = (f: Features): number[] => [1, f.level, f.level * f.level / 10, f.secret];
  const usable = slopes.map((s) => s !== null && Number.isFinite(s.varB) && Number.isFinite(s.b));
  let tau2 = 0.05;
  let beta = [0, 0, 0, 0];
  for (let iter = 0; iter < 4; iter++) {
    const m = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    const v = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      if (!usable[i]) continue;
      const s = slopes[i]!;
      const w = 1 / (s.varB + tau2);
      const f = design(feats[i]);
      const y = Math.min(6, Math.max(-3, s.b));
      for (let a = 0; a < 4; a++) { v[a] += w * f[a] * y; for (let b = 0; b < 4; b++) m[a][b] += w * f[a] * f[b]; }
    }
    const sumW = m[0][0];
    // Ridge toward a flat target (only the intercept is free of penalty).
    for (let a = 1; a < 4; a++) m[a][a] += 0.5 * sumW / Math.max(1, usable.filter(Boolean).length);
    beta = solveN(m, v) ?? beta;
    let num = 0, cnt = 0;
    for (let i = 0; i < n; i++) {
      if (!usable[i]) continue;
      const s = slopes[i]!;
      const t = design(feats[i]).reduce((acc, f, a) => acc + f * beta[a], 0);
      num += (s.b - t) ** 2 - s.varB; cnt++;
    }
    tau2 = cnt > 0 ? Math.min(1, Math.max(0.005, num / cnt)) : 0.05;
  }
  const seen = slopes.filter((s, i) => usable[i]).map((s) => s!.b);
  const lo = seen.length ? Math.min(...seen) : -0.5, hi = seen.length ? Math.max(...seen) : 1.5;
  return slopes.map((s, i) => {
    const target = Math.min(hi, Math.max(lo, design(feats[i]).reduce((acc, f, a) => acc + f * beta[a], 0)));
    if (!usable[i]) return Math.max(0, target);
    const ws = 1 / s!.varB, wt = 1 / tau2;
    return (ws * s!.b + wt * target) / (ws + wt);
  });
}

/**
 * Each trophy's own departure from the shared growth curve (its slope minus the curve's at its level), shrunk toward 0
 * by its precision against the between-trophy variance (estimated by moments).
 */
function shrinkCurveOffsets(lines: Array<Line | null>, levels: number[], curve: (l: number) => number): number[] {
  const raw = lines.map((s, i) => (s && Number.isFinite(s.varB) ? { r: s.b - curve(levels[i]), v: s.varB } : null));
  const ok = raw.filter((x): x is { r: number; v: number } => x !== null);
  const tau2 = ok.length ? Math.min(1, Math.max(0.005, ok.reduce((a, x) => a + x.r * x.r - x.v, 0) / ok.length)) : 0.05;
  return raw.map((x) => (x ? Math.max(-2, Math.min(2, x.r * tau2 / (tau2 + x.v))) : 0));
}

// ------------------------------------------------------------------------------------------------------------------
// Point forecasts (logit medians) from a set of refresh states
// ------------------------------------------------------------------------------------------------------------------

interface ModelSpec { name: string; kind: 'persist' | 'trend' | 'curve'; damp: number; decay: boolean; dilution: boolean }

const MODELS: ModelSpec[] = [
  { name: 'persist', kind: 'persist', damp: 0, decay: false, dilution: false },
  { name: 'trend', kind: 'trend', damp: 1, decay: false, dilution: false },
  { name: 'trend-decay', kind: 'trend', damp: 1, decay: true, dilution: false },
  { name: 'curve', kind: 'curve', damp: 1, decay: false, dilution: false },
  { name: 'curve-decay', kind: 'curve', damp: 1, decay: true, dilution: false },
  { name: 'curve-decay-counts', kind: 'curve', damp: 1, decay: true, dilution: true },
];
/** Prior weight of each model before the in-case backtest speaks. */
const MODEL_PRIOR = [0.1, 0.05, 0.15, 0.1, 0.3, 0.3];

/**
 * The launch-week growth curve shared by every trophy: the slope of logit(rate) in log-time as a smooth function of the
 * current logit level, from a kernel smoother over the trophies' own fitted slopes. A rare trophy today is where a
 * common one was earlier, so integrating this curve carries each trophy along the path the further-along ones took
 * (rising fast from near 0, slowing toward its plateau).
 */
function fitGrowthCurve(lines: Array<Line | null>, levels: number[]): (level: number) => number {
  const pts: Array<{ l: number; b: number; w: number }> = [];
  lines.forEach((s, i) => { if (s && Number.isFinite(s.varB)) pts.push({ l: levels[i], b: Math.min(6, Math.max(-3, s.b)), w: 1 / (s.varB + 0.02) }); });
  if (pts.length < 3) return () => 0;
  const lo = Math.min(...pts.map((p) => p.l)), hi = Math.max(...pts.map((p) => p.l));
  const h = 1.2;
  const at = (l: number): number => {
    let num = 0, den = 0;
    for (const p of pts) { const k = Math.exp(-0.5 * ((l - p.l) / h) ** 2) * p.w; num += k * p.b; den += k; }
    return den > 0 ? num / den : 0;
  };
  // Tabulate on a grid for speed; hold the edge values outside the range seen.
  const grid: number[] = [];
  const step = 0.25;
  for (let l = lo; l <= hi + 1e-9; l += step) grid.push(at(l));
  return (level: number): number => {
    if (level <= lo) return grid[0];
    if (level >= hi) return grid[grid.length - 1];
    const u = (level - lo) / step, k = Math.floor(u), f = u - k;
    return k + 1 < grid.length ? grid[k] * (1 - f) + grid[k + 1] * f : grid[k];
  };
}

/**
 * Carry a logit level along dL/dx = (curve(L) + offset) * exp(-gamma * (x - x0)) over dx, in small midpoint steps: the
 * whole curve slows as the launch cohort's play winds down.
 */
function integrateCurve(start: number, dx: number, curve: (l: number) => number, offset: number, gamma: number): number {
  const steps = 24;
  let l = start;
  const h = dx / steps;
  for (let s = 0; s < steps; s++) {
    const decay = Math.exp(-gamma * (s + 0.5) * h);
    const k1 = (curve(l) + offset) * decay * nearCeiling(l);
    const lm = l + 0.5 * h * k1;
    const k2 = (curve(lm) + offset) * decay * nearCeiling(lm);
    l += h * k2;
  }
  return l;
}

/**
 * Growth fades as a trophy nears every tracked player: some tracked players never start the game (or are tracked
 * before they play), so the last percent or two of non-earners is not worked off like the rest.
 */
const CEILING_L = Math.log(98 / 2);
const nearCeiling = (l: number): number => (l > 0 ? 1 / (1 + Math.exp(2 * (l - CEILING_L))) : 1);

/** Per-trophy recency-weighted trend lines of the latent logit, using only states up to `upto` (weights from there). */
function trophyLines(states: State[], nT: number, upto: number): { lines: Array<Line | null>; levels: number[] } {
  const known = states.filter((s) => s.x <= upto + 1e-9);
  const lines: Array<Line | null> = [];
  const levels: number[] = [];
  for (let i = 0; i < nT; i++) {
    const xs: number[] = [], ys: number[] = [], ws: number[] = [];
    let anyPositive = false;
    for (const s of known) {
      const r = s.rates[i];
      if (r === null) continue;
      if (r > 0) anyPositive = true;
      xs.push(s.x); ys.push(latentLogit(r)); ws.push(recencyWeight(s.x, upto) * roundingWeight(r) / 100);
    }
    const line = anyPositive && xs.length >= 3 ? fitLogTimeTrend(xs, ys, ws) : null;
    lines.push(line);
    levels.push(ys.length ? ys[ys.length - 1] : latentLogit(0));
  }
  return { lines, levels };
}

/**
 * How fast the growth curve itself slows, per unit of log-time: fit the curve on the history as it stood D log-units
 * ago and now, compare the two at the trophies' current levels, gamma = -ln(now / then) / D. Shrunk toward a prior by
 * how much history the earlier fit had.
 */
function estimateSlopeDecay(states: State[], nT: number): number {
  const last = states[states.length - 1];
  const first = states[0];
  const D = Math.min(0.7, (last.x - first.x) / 2);
  const thenX = last.x - D;
  const nThen = states.filter((s) => s.x <= thenX + 1e-9).length;
  if (D < 0.2 || nThen < 3) return GAMMA_PRIOR;
  const now = trophyLines(states, nT, last.x);
  const then = trophyLines(states, nT, thenX);
  const fNow = fitGrowthCurve(now.lines, now.levels);
  const fThen = fitGrowthCurve(then.lines, then.levels);
  let num = 0, den = 0;
  for (let i = 0; i < nT; i++) {
    if (!now.lines[i] || !then.lines[i]) continue;
    const a = fNow(now.levels[i]), b = fThen(now.levels[i]);
    if (b <= 0.05) continue;
    num += a; den += b;
  }
  if (den <= 0 || num <= 0) return GAMMA_PRIOR;
  // Early in a launch the slopes are still rising (players keep starting), which says nothing of the slowdown to come:
  // the data may add decay to the prior, never extrapolate an acceleration, and never count for more than half.
  const gamma = Math.max(0, Math.min(1.5, -Math.log(num / den) / D));
  const k = 0.5 * Math.min(1, (nThen - 2) / 6) * Math.min(1, D / 0.5);
  debug('slope decay', gamma.toFixed(3), 'evidence', k.toFixed(2));
  return k * gamma + (1 - k) * GAMMA_PRIOR;
}

interface PlayersForecast { dLinear: number; dDamped: number }

/** Forecast the change in ln(players tracked) to xT: a recency-weighted line, and a saturating quadratic version. */
function forecastPlayers(states: State[], xT: number): PlayersForecast {
  const last = states[states.length - 1];
  const dx = xT - last.x;
  const xs = states.map((s) => s.x), ys = states.map((s) => Math.log(s.players));
  const ws = states.map((s) => recencyWeight(s.x, last.x));
  const line = fitLogTimeTrend(xs, ys, ws);
  const bLin = line ? Math.max(0, line.b) : 0;
  let dDamped = bLin * dx * 0.75;
  const quad = fitQuadraticAt(xs, ys, ws, last.x);
  if (quad) {
    const slope = Math.max(0, 0.5 * quad.slope + 0.5 * bLin);
    const curv = Math.min(0, 0.5 * quad.curv); // only let curvature slow growth, shrunk by half
    // integrate slope + curv*t over [0,dx], never letting the instantaneous slope go negative
    const tStop = curv < 0 ? Math.min(dx, slope / -curv) : dx;
    dDamped = slope * tStop + 0.5 * curv * tStop * tStop;
  }
  return { dLinear: bLin * dx, dDamped: Math.max(0, dDamped) };
}

/** Each trophy's latent-logit forecast at xT from the states (all of which are post-launch), per model. */
function forecastMedians(states: State[], xT: number, trophies: Trophy[]): number[][] {
  const nT = trophies.length;
  const last = states[states.length - 1];
  const dx = Math.max(0, xT - last.x);
  const lastLevel = (i: number): number => {
    for (let k = states.length - 1; k >= 0; k--) { const r = states[k].rates[i]; if (r !== null) return latentLogit(r); }
    return latentLogit(0);
  };
  const lastPct = (i: number): number => {
    for (let k = states.length - 1; k >= 0; k--) { const r = states[k].rates[i]; if (r !== null) return r; }
    return 0;
  };
  // Per-trophy weighted trend of latent logit vs log-time.
  const { lines } = trophyLines(states, nT, last.x);
  const feats = trophies.map((t, i) => ({ level: lastLevel(i), secret: t.secret ? 1 : 0 }));
  const slopes = shrinkSlopes(lines, feats);
  const players = forecastPlayers(states, xT);
  const levels = trophies.map((_, i) => lastLevel(i));
  const curve = fitGrowthCurve(lines, levels);
  const offsets = shrinkCurveOffsets(lines, levels, curve);
  const gammaFit = MODELS.some((m) => m.decay) ? estimateSlopeDecay(states, nT) : 0;

  return MODELS.map((m) => trophies.map((_, i) => {
    const gamma = m.decay ? gammaFit : 0;
    const anchorLast = lastLevel(i);
    if (m.kind === 'persist') return anchorLast;
    const line = lines[i];
    // Anchor mostly on the last refresh (exact up to rounding), a little on the fitted line.
    const lineAt = line ? line.a + line.b * last.x : anchorLast;
    const wLast = lastPct(i) >= 0.5 ? 0.8 : 0.6;
    const anchor = wLast * anchorLast + (1 - wLast) * lineAt;
    let l: number;
    if (m.kind === 'curve') {
      // A trophy never seen above 0.00% may be far from its first earners: half the curve's pace, from inside [0, 0.005).
      const neverSeen = line === null && lastPct(i) === 0;
      const pace = neverSeen ? ZERO_PACE : 1;
      l = integrateCurve(anchor, dx * m.damp, (lv) => pace * curve(lv), neverSeen ? 0 : offsets[i], gamma);
    } else {
      const span = gamma > 1e-6 ? (1 - Math.exp(-gamma * dx)) / gamma : dx;
      l = anchor + slopes[i] * span * m.damp * (slopes[i] > 0 ? nearCeiling(anchor) : 1);
    }
    if (m.dilution) {
      // The trend has the past dilution baked in; if player growth slows, rates dilute less:
      // ln r gains (1 - rho) * (dLinear - dDamped), with r kept below 1.
      const r = fromLogit(l) / 100;
      const lift = Math.max(-0.4, Math.min(0.4, (1 - DILUTION_RHO) * (players.dLinear - players.dDamped)));
      // A trophy near its plateau cannot gain the whole lift: scale it by the room left below 100%.
      const r2 = Math.min(0.9995, r * Math.exp(lift * (1 - r)));
      l = Math.log(r2 / (1 - r2));
    }
    return l;
  }));
}

// ------------------------------------------------------------------------------------------------------------------
// In-case backtest: pseudo-forecasts at earlier cuts, for model weights and empirical residuals
// ------------------------------------------------------------------------------------------------------------------

interface Pseudo { model: number; trophy: number; resid: number; levelAtCut: number; pairWeight: number }

function pseudoForecasts(post: State[], trophies: Trophy[], dxTarget: number): Pseudo[] {
  const out: Pseudo[] = [];
  const n = post.length;
  for (let c = 2; c < n - 1; c++) {
    const known = post.slice(0, c + 1);
    const xc = known[known.length - 1].x;
    const targets: number[] = [];
    for (let k = c + 1; k < n; k++) {
      const ratio = (post[k].x - xc) / dxTarget;
      if (ratio >= 0.25 && ratio <= 2.0) targets.push(k);
    }
    if (targets.length === 0) continue;
    // Keep the costs bounded: at most 4 targets per cut, spread across the range.
    const pick = targets.length <= 4 ? targets : [0, 1, 2, 3].map((j) => targets[Math.round((j * (targets.length - 1)) / 3)]);
    for (const k of pick) {
      const dx = post[k].x - xc;
      const meds = forecastMedians(known, post[k].x, trophies);
      const scale = Math.pow(dxTarget / dx, 0.8); // normalise each residual to the target's horizon
      const pairWeight = Math.exp(-Math.abs(Math.log(dx / dxTarget))) * (0.5 + c / n);
      for (let i = 0; i < trophies.length; i++) {
        const y = post[k].rates[i];
        const rc = known[known.length - 1].rates[i];
        if (y === null || rc === null) continue;
        for (let m = 0; m < MODELS.length; m++) {
          out.push({ model: m, trophy: i, resid: (logit(y) - logit(fromLogit(meds[m][i]))) * scale, levelAtCut: logit(rc), pairWeight });
        }
      }
    }
  }
  return out;
}

/** Blend weights of the models: prior times a softmax of each model's pseudo-forecast mean absolute logit error. */
function modelWeights(pseudo: Pseudo[]): number[] {
  const err = MODELS.map(() => 0), wsum = MODELS.map(() => 0);
  for (const p of pseudo) { err[p.model] += p.pairWeight * Math.abs(p.resid); wsum[p.model] += p.pairWeight; }
  if (wsum[0] === 0) return MODEL_PRIOR.slice();
  const mae = err.map((e, m) => e / wsum[m]);
  const best = Math.min(...mae);
  // The fewer pairs, the more the prior counts: temper the softmax by the evidence available.
  const evidence = Math.min(1, wsum[0] / (trophiesPerPair(pseudo) * 3));
  const w = MODEL_PRIOR.map((p, m) => p * Math.exp((-(mae[m] - best) / SELECTION_TEMP) * evidence));
  const s = w.reduce((a, b) => a + b, 0);
  debug('model mae', MODELS.map((m, j) => `${m.name}=${mae[j].toFixed(3)}`).join(' '), 'evidence', evidence.toFixed(2));
  return w.map((x) => x / s);
}
const trophiesPerPair = (pseudo: Pseudo[]): number => Math.max(1, new Set(pseudo.map((p) => p.trophy)).size);

const BANDS = [-Infinity, logit(0.1), logit(1), logit(10), logit(50), Infinity];
const bandOf = (l: number): number => { for (let b = 0; b < BANDS.length - 1; b++) if (l < BANDS[b + 1]) return b; return BANDS.length - 2; };

interface Spread { scaleByBand: number[]; stdQuantiles: number[]; bias: number }

/**
 * Turn the blended pseudo-forecast residuals into quantile offsets: a scale per rate band (shrunk to the pooled scale),
 * and the quantiles of the standardised residuals, blended with a normal's so a handful of pairs cannot make them odd.
 */
function calibrateQuantiles(pseudo: Pseudo[], weights: number[], dxTarget: number): Spread {
  const prior = priorSpread(dxTarget);
  // Blend residuals across models per (trophy, pair): residual of the blended median is the weighted residual.
  const blended = new Map<string, { r: number; level: number; w: number }>();
  let idx = 0;
  for (const p of pseudo) {
    const key = `${Math.floor(idx / MODELS.length)}`; // pseudo rows are emitted model-major within one (pair, trophy)
    idx++;
    const cur = blended.get(key) ?? { r: 0, level: p.levelAtCut, w: p.pairWeight };
    cur.r += weights[p.model] * p.resid;
    blended.set(key, cur);
  }
  const rows = [...blended.values()];
  if (rows.length < 30) return prior;
  const totalW = rows.reduce((a, r) => a + r.w, 0);
  const pooledMad = rows.reduce((a, r) => a + r.w * Math.abs(r.r), 0) / totalW;
  const pooledShare = rows.length / (rows.length + SPREAD_PRIOR_ROWS);
  const scaleByBand = prior.scaleByBand.map((p, b) => {
    const inB = rows.filter((r) => bandOf(r.level) === b);
    const wB = inB.reduce((a, r) => a + r.w, 0);
    const madB = wB > 0 ? inB.reduce((a, r) => a + r.w * Math.abs(r.r), 0) / wB : pooledMad;
    const k = inB.length / (inB.length + 20);
    // mean |e| of a normal is 0.798 sigma; then shrink toward the prior by the evidence available
    const emp = (k * madB + (1 - k) * pooledMad) / 0.798;
    return Math.max(0.05, pooledShare * emp + (1 - pooledShare) * p);
  });
  const std = rows.map((r) => ({ v: r.r / scaleByBand[bandOf(r.level)], w: r.w })).sort((a, b) => a.v - b.v);
  const wq = (tau: number): number => {
    let acc = 0;
    for (const s of std) { acc += s.w; if (acc >= tau * totalW) return s.v; }
    return std[std.length - 1].v;
  };
  const empMed = wq(0.5);
  const nShare = rows.length / (rows.length + 200);
  const stdQuantiles = LEVELS.map((tau, j) => nShare * (wq(tau) - empMed) + (1 - nShare) * Z[j]);
  // A systematic miss in the pseudo-forecasts is partly carried into the forecast.
  const bias = BIAS_SHARE * pooledShare * empMed * (scaleByBand.reduce((a, b) => a + b, 0) / scaleByBand.length);
  // Never narrower than the prior's floor.
  const floor = prior.scaleByBand.map((s) => s * 0.5);
  return { scaleByBand: scaleByBand.map((s, b) => Math.max(s, floor[b])), stdQuantiles, bias: Math.max(-0.3, Math.min(0.3, bias)) };
}

/** The spread to use with no usable pseudo-forecasts: a trend's error grows with the log-time horizon. */
function priorSpread(dxTarget: number): Spread {
  const base = 0.12 + 0.45 * dxTarget;
  return { scaleByBand: [1.6, 1.3, 1.1, 1.0, 0.9].map((f) => base * f), stdQuantiles: Z.slice(), bias: 0 };
}

// ------------------------------------------------------------------------------------------------------------------
// Story structure
// ------------------------------------------------------------------------------------------------------------------

/** Chapter N → Chapter N+1 → final mission, by description; the platinum by tier. */
function storyChain(trophies: Trophy[]): number[] {
  const chapters = trophies
    .map((t, i) => ({ i, m: /^Complete Chapter (\d+)\b/i.exec(t.description.trim()) }))
    .filter((c) => c.m)
    .sort((a, b) => Number(a.m![1]) - Number(b.m![1]))
    .map((c) => c.i);
  const finalIdx = trophies.findIndex((t) => /^Complete the final mission\.?$/i.test(t.description.trim()));
  return finalIdx >= 0 ? [...chapters, finalIdx] : chapters;
}

/** A later story trophy never exceeds an earlier one; the platinum never exceeds any trophy. Applied per quantile level. */
function enforceStoryOrder(q: number[][], trophies: Trophy[]): void {
  const chain = storyChain(trophies);
  for (let c = 1; c < chain.length; c++) for (let j = 0; j < 5; j++) q[chain[c]][j] = Math.min(q[chain[c]][j], q[chain[c - 1]][j]);
  const plat = trophies.findIndex((t) => t.tier === 'platinum');
  if (plat >= 0) {
    for (let j = 0; j < 5; j++) {
      let m = Infinity;
      for (let i = 0; i < trophies.length; i++) if (i !== plat) m = Math.min(m, q[i][j]);
      if (Number.isFinite(m)) q[plat][j] = Math.min(q[plat][j], m);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Trophies earned: a check on overall progress
// ------------------------------------------------------------------------------------------------------------------

/**
 * trophies_earned / players is the mean trophies per tracked player, which equals the sum of the rates / 100 up to
 * rounding but is exact. Its own log-time trend gives the expected sum at the target; the common logit shift that makes
 * the forecast sum agree with it is partly applied (to trophies above 1%, where the sum has its weight).
 */
function reconcileWithTrophiesEarned(states: State[], xT: number, med: number[]): number {
  const usable = states.filter((s) => s.earned !== null && s.earned > 0);
  if (usable.length < 3) return 0;
  const last = usable[usable.length - 1];
  const line = fitLogTimeTrend(usable.map((s) => s.x), usable.map((s) => Math.log(s.earned! / s.players)), usable.map((s) => recencyWeight(s.x, last.x)));
  if (!line) return 0;
  const targetSum = (last.earned! / last.players) * Math.exp(line.b * Math.max(0, xT - last.x));
  const sumAt = (shift: number): number => med.reduce((a, l) => a + fromLogit(l + shift) / 100, 0);
  let lo = -1, hi = 1;
  if (sumAt(lo) > targetSum || sumAt(hi) < targetSum) return 0;
  for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (sumAt(mid) < targetSum) lo = mid; else hi = mid; }
  const shift = (lo + hi) / 2;
  debug('trophies-earned shift', shift.toFixed(3));
  return Math.max(-0.2, Math.min(0.2, TE_RECONCILE * shift));
}

// ------------------------------------------------------------------------------------------------------------------
// One case
// ------------------------------------------------------------------------------------------------------------------

function persistenceRows(c: Case): Row[] {
  const last = c.history[c.history.length - 1];
  const spread = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return c.trophies.map((t, i) => {
    const l = logit(last?.rates?.[i] ?? 0);
    return { id: t.id, q: Z.map((z) => round4(100 / (1 + Math.exp(-(l + z * spread))))) };
  });
}

function forecastCase(c: Case): Row[] {
  const nT = c.trophies.length;
  const states = dedupeRefreshes(c.history, nT);
  if (states.length === 0) throw new Error('no usable reads');
  const post = states.filter((s) => s.tHours >= MIN_POST_LAUNCH_HOURS);
  const targetHours = hoursOf(c.target);
  const lastReadHours = hoursOf(c.history[c.history.length - 1].at);
  const q: number[][] = [];

  if (post.length < 2) {
    // Too little history for any trend (the practice cases: only launch-night pages). A refresh is likely before the
    // target, and early refreshes add many new players with few trophies: lean the median down and keep it wide.
    const last = states[states.length - 1];
    const days = Math.max(0.01, (targetHours - lastReadHours + (lastReadHours - last.tHours)) / 24);
    const youngPage = last.tHours < 24;
    const sigma = Math.max(0.5 * Math.sqrt(days), youngPage ? 0.9 : 0.6);
    for (let i = 0; i < nT; i++) {
      const r = last.rates[i] ?? 0;
      const shift = youngPage && r < 99.995 ? -0.45 : 0;
      const l = latentLogit(r) + shift;
      q.push(Z.map((z) => fromLogit(l + z * sigma)));
    }
    debug(`${c.id}: ${states.length} states, ${post.length} post-launch, prior branch`);
  } else {
    const lastState = post[post.length - 1];
    const cadence = estimateRefreshCadence(post, lastReadHours);
    const tEff = effectiveTargetHours(targetHours, lastState.tHours, cadence);
    const xT = timeX(tEff);
    const dxTarget = Math.max(0.02, xT - lastState.x);
    const meds = forecastMedians(post, xT, c.trophies);
    const pseudo = pseudoForecasts(post, c.trophies, dxTarget);
    const weights = modelWeights(pseudo);
    const spread = calibrateQuantiles(pseudo, weights, dxTarget);
    let med = c.trophies.map((_, i) => meds.reduce((a, mm, m) => a + weights[m] * mm[i], 0));
    if (process.env.FORECAST_DEBUG === '2') {
      for (let i = 0; i < nT; i++) console.error(`${String(c.trophies[i].id).padStart(3)} ${String(lastState.rates[i]).padStart(6)} ${MODELS.map((m, j) => `${m.name}=${fromLogit(meds[j][i]).toFixed(2)}`).join(' ')}`);
    }
    const teShift = reconcileWithTrophiesEarned(post, xT, med);
    med = med.map((l, i) => l + (fromLogit(l) > 1 ? teShift : 0) + spread.bias);
    debug(`${c.id}: ${states.length} states, ${post.length} post-launch, cadence ${cadence.toFixed(2)}h, tEff ${tEff.toFixed(1)}h, dx ${dxTarget.toFixed(3)}, pseudo ${pseudo.length / MODELS.length}`);
    debug('weights', MODELS.map((m, j) => `${m.name}=${weights[j].toFixed(2)}`).join(' '));
    debug('scales', spread.scaleByBand.map((s) => s.toFixed(3)).join(' '), 'stdQ', spread.stdQuantiles.map((s) => s.toFixed(2)).join(' '), 'bias', spread.bias.toFixed(3));
    for (let i = 0; i < nT; i++) {
      const band = bandOf(logit(fromLogit(med[i])));
      // Rare trophies printed as 0.00 carry no slope of their own: give their upper side extra room.
      const lastR = lastState.rates[i] ?? 0;
      const zeroBoost = lastR < 0.005 ? 1.3 : 1;
      const s = spread.scaleByBand[band] * SPREAD_INFLATE;
      q.push(spread.stdQuantiles.map((z, j) => fromLogit(med[i] + z * s * (j > 2 ? zeroBoost : 1))));
    }
  }
  enforceStoryOrder(q, c.trophies);
  return c.trophies.map((t, i) => ({ id: t.id, q: q[i] }));
}

/** Rows to the contest's shape: finite, 0..100, 4 decimals, non-decreasing. Throws if anything is off. */
function finalizeRows(rows: Row[], c: Case): Row[] {
  if (rows.length !== c.trophies.length) throw new Error('row count');
  return rows.map((r) => {
    const q = r.q.map((v) => { if (!Number.isFinite(v)) throw new Error(`non-finite quantile for ${r.id}`); return round4(Math.min(100, Math.max(0, v))); });
    for (let j = 1; j < 5; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { id: r.id, q };
  });
}

function writeForecast(id: string, rows: Row[]): void {
  const body = `${JSON.stringify({ trophies: rows })}\n`;
  if (Buffer.byteLength(body) > 65_536) throw new Error('output too large');
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), body);
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
  for (const file of inputs) {
    const id = file.slice(0, -'.in'.length);
    let c: Case;
    try {
      c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    } catch (e) {
      console.error(`${file}: unreadable case: ${String(e)}`);
      continue;
    }
    let rows: Row[];
    try {
      rows = finalizeRows(forecastCase(c), c);
    } catch (e) {
      console.error(`${file}: model failed, house persistence used: ${String((e as Error)?.stack ?? e)}`);
      rows = finalizeRows(persistenceRows(c), c);
    }
    writeForecast(id, rows);
  }
}

main();

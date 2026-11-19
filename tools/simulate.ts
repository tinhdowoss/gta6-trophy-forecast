// A synthetic launch week of Exophase's GTA VI page, for backtesting while the real page cannot be read.
//
//   node tools/simulate.ts --trophies <case.in or trophies.json> --seed 1 [--out <dir>]
//
// Writes <out>/reads.jsonl (one read every 10 minutes in the case-history shape) and <out>/trophies.json, by default to
// forecast-data/synthetic/s<seed>/ beside the repository. These are the simulator's assumptions, not data:
//   - players buy the game over the week (most on day one) and play a lognormal number of hours a day;
//   - Exophase starts tracking a player some lognormal delay after they start, so the tracked base keeps adding
//     players who have played little (dilution);
//   - each trophy needs a number of play hours (story chapters in order, side content scattered, completionist content
//     late and optional), scaled per player; platinum needs every other trophy;
//   - Exophase refreshes on a cadence drawn per seed (1 to 12 hours, jittered); the page prints rates to 2 decimals.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Trophy { id: number; name: string; description: string; tier: string; points: number; secret: boolean }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const arg = (name: string, dflt: string): string => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const seed = Number(arg('--seed', '1'));
const rnd = mulberry32(seed * 7919 + 13);
const normal = (): number => { const u = Math.max(1e-12, rnd()), v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const lognormal = (median: number, sd: number): number => median * Math.exp(sd * normal());
const uniform = (a: number, b: number): number => a + (b - a) * rnd();

const here = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const src = JSON.parse(readFileSync(arg('--trophies', here('../../kit-forecast/gta6-trophy-rarity-forecast-01-kit/input/p00.in')), 'utf8'));
const trophies: Trophy[] = Array.isArray(src) ? src : src.trophies;
const prelaunch: Array<number | null> | null = Array.isArray(src) ? null : src.history?.[0]?.rates ?? null;
const outDir = arg('--out', join(process.env.FORECAST_DATA ?? here('../../forecast-data'), 'synthetic', `s${seed}`));

// ---- trophy archetypes: (play hours needed, chance a player ever goes for it) ----
interface Need { hours: number; prob: number; spread: number }
const chapterHours = [6, 14, 24, 34].map((h) => h * uniform(0.8, 1.25));
const finalHours = chapterHours[3] * uniform(1.25, 1.5);
const needs: Need[] = trophies.map((t) => {
  const d = t.description;
  const ch = /Complete Chapter (\d+)/.exec(d);
  if (t.tier === 'platinum') return { hours: 0, prob: 0, spread: 0 };
  if (ch) return { hours: chapterHours[Math.min(3, Number(ch[1]) - 1)], prob: 0.97, spread: 0.25 };
  if (/final mission\.$/.test(d) && !/for /.test(d)) return { hours: finalHours, prob: 0.95, spread: 0.25 };
  if (/100% Completion/.test(d)) return { hours: uniform(90, 160), prob: uniform(0.03, 0.12), spread: 0.3 };
  if (/final mission for/.test(d)) return { hours: uniform(15, 45), prob: uniform(0.4, 0.8), spread: 0.4 };
  if (/Gone Fishing/.test(d)) return { hours: 0.4, prob: 0.995, spread: 0.3 };
  if (t.secret && /^Complete /.test(d)) return { hours: uniform(3, finalHours * 0.95), prob: 0.95, spread: 0.3 };
  if (t.secret) return { hours: uniform(1, 30), prob: uniform(0.55, 0.97), spread: 0.4 };
  if (/\b(all|every|100|250|50|20|3 Collectible|10 vehicles)\b/.test(d)) return { hours: uniform(25, 110), prob: uniform(0.05, 0.4), spread: 0.5 };
  return { hours: uniform(1, 25), prob: uniform(0.2, 0.8), spread: 0.6 };
});
const platIdx = trophies.findIndex((t) => t.tier === 'platinum');

// ---- players ----
// --pace scales how fast players play (below 1: a calmer week whose rates move less); --late scales how late players
// buy and get tracked (above 1: more dilution by newcomers through the week).
const pace = Number(arg('--pace', '1'));
const late = Number(arg('--late', '1'));
const N = Math.round(uniform(40_000, 120_000));
const buyMeanH = uniform(10, 30) * late;
const trackDelayMedH = uniform(12, 48) * late;
const interestMedH = uniform(15, 35); // total hours a player will put in this week, median
const hoursPerDayMed = uniform(2, 4) * pace;
const nT = trophies.length;
// visible[i] = sorted clock hours at which each player's trophy i became visible to Exophase
const visible: number[][] = trophies.map(() => []);
const tracked: number[] = [];
for (let j = 0; j < N; j++) {
  const start = rnd() < 0.55 ? -Math.log(Math.max(1e-9, rnd())) * buyMeanH * 0.4 : -Math.log(Math.max(1e-9, rnd())) * buyMeanH * 3;
  const track = start + lognormal(trackDelayMedH, 1.3);
  const speed = lognormal(hoursPerDayMed, 0.55) / 24; // play hours per clock hour
  const skill = lognormal(1, 0.3);
  const completionist = lognormal(1, 0.6);
  const interest = lognormal(interestMedH, 0.9); // play hours after which the player stops
  tracked.push(track);
  let lastEarn = 0, all = true;
  for (let i = 0; i < nT; i++) {
    if (i === platIdx) continue;
    const n = needs[i];
    if (rnd() > Math.min(1, n.prob * (n.prob < 0.5 ? completionist : 1))) { all = false; continue; }
    const playH = n.hours * skill * Math.exp(n.spread * normal());
    if (playH > interest) { all = false; continue; }
    const earnAt = start + playH / speed;
    visible[i].push(Math.max(earnAt, track));
    lastEarn = Math.max(lastEarn, earnAt);
  }
  if (platIdx >= 0 && all) visible[platIdx].push(Math.max(lastEarn + 0.1, track));
}
for (const v of visible) v.sort((a, b) => a - b);
tracked.sort((a, b) => a - b);
const countLE = (arr: number[], t: number): number => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) lo = m + 1; else hi = m; } return lo; };

// ---- refresh schedule and reads ----
const LAUNCH = Date.parse('2026-11-19T00:00:00Z');
const cadence = [1, 2, 3, 6, 8, 12][Math.floor(rnd() * 6)];
const refreshes: number[] = [];
for (let t = uniform(3.5, 4.5); t < 24 * 8; t += cadence * uniform(0.75, 1.25)) refreshes.push(t);
interface PageState { players: number; earned: number; rates: Array<number | null> }
const stateAt = (t: number): PageState => {
  const P = Math.max(1, countLE(tracked, t));
  let earned = 0;
  const rates = visible.map((v) => { const e = countLE(v, t); earned += e; return Math.round((e / P) * 10000) / 100; });
  return { players: P, earned, rates };
};
const pre: PageState = prelaunch ? { players: 638, earned: 943, rates: prelaunch } : stateAt(0);
mkdirSync(outDir, { recursive: true });
const lines: string[] = [];
let ri = -1;
let cur: PageState = pre;
for (let ms = Date.parse('2026-11-18T23:50:00Z'); ms <= LAUNCH + 24 * 8 * 3_600_000; ms += 600_000) {
  const h = (ms - LAUNCH) / 3_600_000;
  while (ri + 1 < refreshes.length && refreshes[ri + 1] <= h) { ri++; cur = stateAt(refreshes[ri]); }
  const at = new Date(ms + 300).toISOString();
  lines.push(JSON.stringify({ slot: new Date(ms).toISOString().replace('.000Z', 'Z'), at, players_tracked: cur.players, trophies_earned: cur.earned, rates: cur.rates }));
}
writeFileSync(join(outDir, 'reads.jsonl'), `${lines.join('\n')}\n`);
writeFileSync(join(outDir, 'trophies.json'), `${JSON.stringify(trophies, null, 1)}\n`);
const fin = stateAt(24 * 7);
console.log(`seed ${seed}: N ${N}, cadence ${cadence}h, refreshes ${refreshes.length}, day-7 players ${fin.players}, ch1 ${fin.rates[2]}%, final ${fin.rates[6]}%, plat ${fin.rates[platIdx]}%`);

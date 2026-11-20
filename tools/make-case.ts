// Builds pseudo-cases (makefun/gta6-trophies-case/v1) with their answers, for tools/backtest.ts.
//
//   node tools/make-case.ts [--worlds 24] [--seed 1] [--out <dir>] [--data <forecast-data dir>] [--kit <kit dir>]
//
// Two sources:
//  1. real reads: forecast-data/reads.jsonl (+ trophies.json), from tools/collect.ts. Every cut point that leaves a
//     later read as its answer becomes a case. Only used when there are reads enough to span a horizon.
//  2. simulated worlds: Exophase could not be read from here (HTTP 403), so the backtest also needs worlds of its own.
//     Each world is a population of players with its own launch-week dynamics, generated from scratch with a seeded
//     PRNG, and read the way the house reads the page:
//       - the launch-night tester page of the practice cases (638 players, their earner counts) stays in the counts;
//       - players start over the week (a saturating arrival curve fitted to 3,868 tracked at the 04:15 refresh), are
//         tracked once they earn the opening trophy and Exophase scans them with a lag;
//       - each plays at a heavy-tailed number of hours a day, goes through the story at their own speed, drops out after
//         a heavy-tailed number of hours, and takes up each side activity with its own probability and hours needed;
//         completionists chase everything, and 100% / platinum come once a player has every other trophy;
//       - Exophase refreshes on a cadence of its own (1 to 12 h, jittered, sometimes skipping); every read shows the
//         last refresh before it, with rates printed to 2 decimals.
//     The world's numbers are drawn at random per world (seeded), so a model that only fits one story does badly.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, dflt: string): string => {
  const k = process.argv.indexOf(`--${name}`);
  return k >= 0 && process.argv[k + 1] ? process.argv[k + 1] : dflt;
};
const DATA = resolve(arg('data', join(repoRoot, '..', 'forecast-data')));
const KIT = resolve(arg('kit', join(repoRoot, '..', 'kit-forecast', 'gta6-trophy-rarity-forecast-01-kit')));
const OUT = resolve(arg('out', join(DATA, 'pseudo')));
const WORLDS = Number(arg('worlds', '24'));
const SEED = Number(arg('seed', '1'));
const PLAYERS = Number(arg('players', '20000'));

const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
const iso = (h: number): string => new Date(LAUNCH_MS + Math.round(h * 3_600_000)).toISOString().replace('.000Z', 'Z');

/** The cuts each world is cased at: [checkpoint hour, target hour]. The first is the final's own shape. */
const CUTS: Array<[string, number, number]> = [
  ['final', 59.5, 168],
  ['early', 35.5, 144],
];

interface Trophy { id: number; name: string; description: string; tier: string; points: number; secret: boolean }
interface Read { slot: string; at: string; players_tracked: number; trophies_earned: number; rates: Array<number | null> }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function writeCase(name: string, base: Record<string, unknown>, trophies: Trophy[], history: Read[], at: number, target: number, answer: number[]): void {
  const c = {
    ...base,
    id: name,
    at: iso(at),
    horizon_minutes: Math.round((target - at) * 60),
    target: iso(target),
    levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    trophies,
    history,
  };
  writeFileSync(join(OUT, `${name}.in`), JSON.stringify(c));
  writeFileSync(join(OUT, `${name}.ans`), JSON.stringify({ rates: answer }));
}

/** Cases from real collected reads: each checkpoint on the half hour with a read 24-108 h later as its answer. */
function casesFromReads(base: Record<string, unknown>, template: Trophy[]): number {
  const file = join(DATA, 'reads.jsonl');
  if (!existsSync(file)) return 0;
  const reads = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Read);
  const trophiesFile = join(DATA, 'trophies.json');
  const trophies = existsSync(trophiesFile) ? (JSON.parse(readFileSync(trophiesFile, 'utf8')) as Trophy[]) : template;
  const hours = reads.map((r) => (Date.parse(r.at) - LAUNCH_MS) / 3_600_000);
  let made = 0;
  for (let k = 0; k < reads.length; k++) {
    for (const horizon of [108.5, 72, 48, 24]) {
      const at = hours[k] + 0.01;
      const j = hours.findIndex((h) => h >= at + horizon && h < at + horizon + 1);
      if (j < 0) continue;
      const history = reads.slice(0, k + 1).filter((r) => r.rates.length === trophies.length);
      if (history.length < 3) continue;
      writeCase(`real-${k}-${horizon}`, base, trophies, history, at, at + horizon, reads[j].rates as number[]);
      made++;
      break;
    }
  }
  return made;
}

type Kind = 'opening' | 'story' | 'storyBeat' | 'sideStory' | 'misc' | 'grind' | 'completion' | 'platinum';

/** What sort of trophy each is, from its tier and description. */
function kindOf(t: Trophy): Kind {
  const d = t.description;
  if (t.tier === 'platinum') return 'platinum';
  if (/100% Completion/i.test(d)) return 'completion';
  if (/^Complete Chapter \d+\.?$/i.test(d) || /^Complete the final mission\.?$/i.test(d)) return 'story';
  if (/final mission for|Hunt a unique animal/i.test(d)) return 'sideStory';
  if (/^Complete [A-Z][^.]*\.$/.test(d) && t.secret) return 'storyBeat';
  if (/\b(all|every|\d{2,}|each)\b/i.test(d) && !/Try each/i.test(d)) return 'grind';
  if (t.secret) return 'storyBeat';
  return 'misc';
}

const clamp01 = (k: number, max: number): number => Math.max(0, Math.min(max, Math.floor(k)));

function simulateWorld(w: number, base: Record<string, unknown>, trophies: Trophy[], testerRates: number[]): void {
  const rnd = mulberry32(SEED * 1_000_003 + w * 7919);
  const u = (a: number, b: number): number => a + (b - a) * rnd();
  const normal = (): number => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const logn = (med: number, sd: number): number => med * Math.exp(sd * normal());
  const n = trophies.length;
  // The trophy every tester already had at 100% is the opening one every tracked player has.
  const kinds = trophies.map((t, i): Kind => (testerRates[i] >= 99.99 ? 'opening' : kindOf(t)));

  // World-level numbers.
  const tau = u(25, 160);          // arrival time scale (h)
  const shape = u(0.55, 1.1);      // arrival curve shape
  const scanLag = u(0.2, 6);       // mean hours between earning and Exophase seeing it
  const startLag = u(0, 10);       // mean hours between starting and being tracked
  const playMed = u(0.1, 0.22);    // median hours played per real hour
  const playSd = u(0.5, 0.9);
  const storyLen = u(28, 55);      // median story length in play-hours
  const dropMed = u(20, 70);       // median play-hours before a player drops the game
  const completionists = u(0.01, 0.06);
  const cadence = [1, 2, 3, 4, 6, 8, 12][Math.floor(rnd() * 7)];
  const skipProb = u(0, 0.2);
  // Play is not even over the day: a daily swing (peak in the US evening) and a weekend lift (21-22 Nov).
  const swing = u(0.2, 0.8);
  const weekend = u(1, 1.6);
  const paceNoise = u(0.05, 0.35);  // per-player, per-stretch noise on story pacing
  // Some worlds see Exophase import a batch of already-playing accounts at once.
  const backfillAt = rnd() < 0.5 ? u(20, 150) : Infinity;
  const backfillShare = u(0.1, 0.3);
  const STEP = 0.25;
  const intensity: number[] = [];
  for (let t = -1; t < 400; t += STEP) {
    const day = Math.floor((t + 5) / 24); // US-ish days
    intensity.push(Math.max(0.05, 1 + swing * Math.sin((2 * Math.PI * (t - 18)) / 24)) * (day === 2 || day === 3 ? weekend : 1));
  }
  const cum: number[] = [0];
  for (const v of intensity) cum.push(cum[cum.length - 1] + v * STEP);
  const cumAt = (t: number): number => { const k = clamp01((t + 1) / STEP, cum.length - 2); const f = (t + 1) / STEP - k; return cum[k] + f * (cum[k + 1] - cum[k]); };
  const timeAt = (c: number): number => {
    let lo = 0, hi = cum.length - 1;
    if (c >= cum[hi]) return Infinity;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= c) lo = m; else hi = m; }
    return -1 + (lo + (c - cum[lo]) / (cum[hi] - cum[lo])) * STEP;
  };

  // Each trophy's place: a story fraction, or a take-up probability and hours needed.
  const chapterFrac: Record<string, number> = {};
  const chapterMarks = [u(0.06, 0.15), u(0.22, 0.34), u(0.42, 0.56), u(0.65, 0.8)];
  const frac: number[] = [];
  const takeUp: number[] = [];
  const hoursNeeded: number[] = [];
  trophies.forEach((t, i) => {
    const ch = /^Complete Chapter (\d+)/i.exec(t.description);
    frac.push(ch ? chapterMarks[Math.min(3, Number(ch[1]) - 1)] : /final mission\.?$/i.test(t.description) && kinds[i] === 'story' ? 1 : u(0.03, 0.97));
    switch (kinds[i]) {
      case 'sideStory': takeUp.push(u(0.4, 0.9)); frac[i] = u(0.3, 1.2); hoursNeeded.push(0); break;
      case 'storyBeat': takeUp.push(u(0.85, 1)); hoursNeeded.push(0); break;
      case 'misc': takeUp.push(u(0.25, 0.95)); hoursNeeded.push(logn(u(1.5, 20), 0.5)); break;
      case 'grind': takeUp.push(u(0.04, 0.45)); hoursNeeded.push(logn(u(12, 70), 0.4)); break;
      default: takeUp.push(1); hoursNeeded.push(0);
    }
  });
  void chapterFrac;

  // Arrivals: tracked-player curve N * (1 - exp(-(h / tau)^shape)), with 3,868 tracked near 04:15.
  const at45 = 1 - Math.exp(-Math.pow(4.25 / tau, shape));
  const total = 3230 / at45; // 3,868 minus the 638 testers
  const weight = total / PLAYERS;
  const visible: number[][] = Array.from({ length: n }, () => []);
  const trackedAt: number[] = [];
  const order = trophies.map((_, i) => i).filter((i) => kinds[i] !== 'completion' && kinds[i] !== 'platinum');
  for (let p = 0; p < PLAYERS; p++) {
    let arrival = tau * Math.pow(-Math.log(1 - rnd() * 0.999999), 1 / shape);
    const start = Math.max(-0.5, arrival - startLag * -Math.log(1 - rnd()));
    if (rnd() < backfillShare && arrival < backfillAt) arrival = backfillAt;
    const rate = Math.min(0.75, logn(playMed, playSd));
    const story = logn(storyLen, 0.3);
    const drop = logn(dropMed, 1);
    const completionist = rnd() < completionists;
    const lag = scanLag * -Math.log(1 - rnd());
    const c0 = cumAt(start);
    const earnAt = (playHours: number): number => (playHours <= drop ? timeAt(c0 + playHours / rate) + lag : Infinity);
    // This player's pace through the story wanders: each story fraction is stretched by a running random factor.
    const storyFrac = (f: number): number => f * Math.exp(paceNoise * normal() * Math.sqrt(f));
    const opening = earnAt(0.3);
    const tracked = Math.max(arrival, opening);
    trackedAt.push(tracked);
    const times: number[] = new Array(n).fill(Infinity);
    // Chapters stay in order for every player: each chapter's mark is the running maximum of the noisy marks.
    let chapterMark = 0;
    const chapterIdx = order.filter((i) => kinds[i] === 'story').sort((a, b) => frac[a] - frac[b]);
    const chapterAt = new Map<number, number>();
    for (const i of chapterIdx) { chapterMark = Math.max(chapterMark, storyFrac(frac[i])); chapterAt.set(i, chapterMark); }
    for (const i of order) {
      let t = Infinity;
      if (kinds[i] === 'opening') t = opening;
      else if (kinds[i] === 'story') t = earnAt(story * (chapterAt.get(i) as number));
      else if (kinds[i] === 'storyBeat') t = rnd() < takeUp[i] ? earnAt(story * storyFrac(frac[i])) : Infinity;
      else if (kinds[i] === 'sideStory') t = completionist || rnd() < takeUp[i] ? earnAt(story * storyFrac(frac[i])) : Infinity;
      else t = completionist || rnd() < takeUp[i] ? earnAt(logn(hoursNeeded[i], 0.5) * (completionist ? 0.7 : 1)) : Infinity;
      times[i] = t;
    }
    const all = order.reduce((m, i) => Math.max(m, times[i]), 0);
    const cleanup = completionist ? earnAt(Math.max(story, ...order.map((i) => hoursNeeded[i])) * 1.3) : Infinity;
    trophies.forEach((_, i) => {
      if (kinds[i] === 'completion' || kinds[i] === 'platinum') times[i] = Math.max(all, cleanup) + (kinds[i] === 'platinum' ? 0.01 : 0);
    });
    for (let i = 0; i < n; i++) if (Number.isFinite(times[i])) visible[i].push(Math.max(tracked, times[i]));
  }
  for (const v of visible) v.sort((a, b) => a - b);
  trackedAt.sort((a, b) => a - b);
  const countUpTo = (sorted: number[], t: number): number => {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) lo = m + 1; else hi = m; }
    return lo;
  };
  const testers = 638;
  const testerCounts = testerRates.map((r) => Math.round((r / 100) * testers));

  // Exophase's refreshes: 04:15, then the world's cadence, jittered, sometimes skipped.
  const refreshes: Array<{ h: number; players: number; earned: number; rates: number[] }> = [];
  const page = (h: number) => {
    const players = testers + Math.round(countUpTo(trackedAt, h) * weight);
    const counts = visible.map((v, i) => testerCounts[i] + Math.round(countUpTo(v, h) * weight));
    return { h, players, earned: counts.reduce((a, b) => a + b, 0), rates: counts.map((c) => Math.min(100, Math.round((10_000 * c) / players) / 100)) };
  };
  refreshes.push({ h: -0.2, players: testers, earned: testerCounts.reduce((a, b) => a + b, 0), rates: testerRates });
  let h = 4.25;
  while (h < 175) {
    if (rnd() >= skipProb || h < 5) refreshes.push(page(h));
    h += cadence * u(0.8, 1.2);
  }
  const stateAt = (t: number) => {
    let s = refreshes[0];
    for (const r of refreshes) if (r.h <= t) s = r;
    return s;
  };
  // The house's reads: every 30 min from 23:50 on launch eve, every 10 min from 12:00 on launch day.
  const readHours: number[] = [-1 / 6];
  for (let t = 0; t < 12; t += 0.5) readHours.push(t);
  for (let t = 12; t < 175; t += 1 / 6) readHours.push(Math.round(t * 600) / 600);
  for (const [label, cut, target] of CUTS) {
    const history: Read[] = readHours.filter((t) => t < cut).map((t) => {
      const s = stateAt(t);
      return { slot: iso(t), at: iso(t + 0.0001), players_tracked: s.players, trophies_earned: s.earned, rates: s.rates };
    });
    writeCase(`w${String(w).padStart(2, '0')}-${label}`, base, trophies, history, cut, target, stateAt(target + 0.001).rates);
  }
  process.stdout.write(`w${w}: tau ${tau.toFixed(0)} h, shape ${shape.toFixed(2)}, cadence ${cadence} h, story ${storyLen.toFixed(0)} h, play ${(playMed * 24).toFixed(1)} h/day, players at 168 h ${stateAt(168).players}\n`);
}

function main(): void {
  mkdirSync(OUT, { recursive: true });
  const practice = JSON.parse(readFileSync(join(KIT, 'input', 'p01.in'), 'utf8')) as Record<string, unknown> & { trophies: Trophy[]; history: Read[] };
  const { trophies, history, ...rest } = practice;
  const base = { schema: rest.schema, game: rest.game, notes: 'pseudo-case built by tools/make-case.ts' };
  const real = casesFromReads(base, trophies);
  console.log(`${real} cases from collected reads`);
  const testerRates = history[history.length - 1].rates as number[];
  for (let w = 0; w < WORLDS; w++) simulateWorld(w, base, trophies, testerRates);
  console.log(`wrote ${WORLDS * CUTS.length} simulated cases to ${OUT}`);
}

main();

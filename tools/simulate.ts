// A synthetic GTA VI launch week on Exophase, for backtesting only (simulator assumptions, not data).
//
//   node tools/simulate.ts --seed 1 [--out <dir>]      (default <forecast-data>/sim/s<seed>)
//
// Players start the game after launch, become tracked by Exophase some hours later, play at their own intensity
// until they drop off, and earn a trophy once their hours reach that trophy's threshold (story trophies in chapter
// order, side activities only for interested players, collectibles and 100% completion late and rarely). The page
// starts as the launch-night page the house saw (638 players, pre-release accounts), Exophase refreshes on its own
// random cadence (sometimes serving a stale page again), and the house reads every 30 minutes, then every 10 minutes.
// Writes reads.jsonl and trophies.json in the shape tools/collect.ts writes them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT_INPUT = process.env.KIT_INPUT ?? join(REPO, '..', 'kit-forecast', 'gta6-trophy-rarity-forecast-01-kit', 'input');
const DATA = process.env.FORECAST_DATA ?? join(REPO, '..', 'forecast-data');
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** mulberry32: a small seeded generator, so a seed always gives the same week. */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Trophy {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
}

/** Hours of play a trophy needs (median) and the share of players who go for it at all. */
function trophyDesign(t: Trophy, rnd: () => number, normal: () => number): { hours: number; interest: number; jitter: number } {
  const d = t.description;
  const vary = (x: number, s = 0.25): number => x * Math.exp(s * normal());
  const chapter = /Chapter (\d)/.exec(d);
  if (t.tier === 'platinum') return { hours: Infinity, interest: 1, jitter: 0 };
  if (/Gone Fishing/.test(d)) return { hours: vary(0.4), interest: 1, jitter: 0.3 };
  if (chapter) return { hours: vary([0, 5, 12, 21, 31][Number(chapter[1])] ?? 30), interest: 1, jitter: 0.25 };
  if (/final mission\.$/.test(d)) return { hours: vary(42), interest: 1, jitter: 0.25 };
  if (/100% Completion/.test(d)) return { hours: vary(140, 0.3), interest: 0.06, jitter: 0.2 };
  if (/Breakfast Run|Cartel Heist|Child's Play|Headliners|VCIA Takedown|Savage Glory/.test(d)) {
    return { hours: vary(4 + 34 * rnd()), interest: 1, jitter: 0.25 };
  }
  if (/final mission for/.test(d)) return { hours: vary(18 + 30 * rnd()), interest: 0.4 + 0.4 * rnd(), jitter: 0.35 };
  if (/250 Stunts|100 locations|every spot|Collectible Card|every location|all Shooting|Explore all|all garage|50 Challenges|8 mission strands/.test(d)) {
    return { hours: vary(35 + 70 * rnd(), 0.3), interest: 0.08 + 0.3 * rnd(), jitter: 0.4 };
  }
  if (t.secret) return { hours: vary(1 + 30 * rnd()), interest: 0.85 + 0.15 * rnd(), jitter: 0.4 };
  return { hours: vary(2 + 20 * rnd(), 0.4), interest: 0.2 + 0.7 * rnd(), jitter: 0.6 };
}

function main(): void {
  const seed = Number(argValue('seed', '1'));
  const out = resolve(argValue('out', join(DATA, 'sim', `s${seed}`)));
  const rnd = makeRandom(seed * 7919 + 13);
  const normal = (): number => {
    const u = Math.max(1e-12, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const practice = JSON.parse(readFileSync(join(KIT_INPUT, 'p00.in'), 'utf8')) as { trophies: Trophy[]; history: Array<{ rates: number[]; players_tracked: number }> };
  const trophies = practice.trophies;
  const launchPage = practice.history[0];
  const nT = trophies.length;

  // The week's regime: how many players, how fast they arrive and sync, how hard they play, how often Exophase refreshes.
  const nPlayers = Math.round(Math.exp(Math.log(15_000) + rnd() * Math.log(8))); // 15k .. 120k tracked by the end
  const earlyShare = 0.35 + 0.4 * rnd();
  const lateMean = 40 + 200 * rnd();
  const syncMean = 1 + 20 * rnd() ** 2;
  const intensityMedian = 0.08 + 0.1 * rnd(); // hours played per hour (2 to 4.3 h a day)
  const capMedian = 15 + 45 * rnd(); // hours played before a player drops the game
  const refreshGap = 0.3 + 3 * rnd() ** 1.5; // median hours between Exophase refreshes
  const staleChance = 0.05 * rnd();
  const design = trophies.map((t) => trophyDesign(t, rnd, normal));
  const plat = trophies.findIndex((t) => t.tier === 'platinum');

  // Effective time from which each player's trophy counts on the page: max(tracked, earned).
  const counted: Float64Array[] = design.map(() => new Float64Array(nPlayers));
  const tracked = new Float64Array(nPlayers);
  for (let p = 0; p < nPlayers; p++) {
    const start = rnd() < earlyShare ? -Math.log(1 - rnd()) * 6 : -Math.log(1 - rnd()) * lateMean;
    const track = start + -Math.log(1 - rnd()) * syncMean;
    tracked[p] = track;
    const intensity = Math.min(0.7, intensityMedian * Math.exp(0.7 * normal()));
    const cap = capMedian * Math.exp(1.0 * normal());
    let platTime = 0;
    for (let j = 0; j < nT; j++) {
      if (j === plat) continue;
      const d = design[j];
      let earn = Infinity;
      if (rnd() < d.interest) {
        const need = d.hours * Math.exp(d.jitter * normal());
        if (need <= cap) earn = start + need / intensity;
      }
      counted[j][p] = Math.max(track, earn);
      platTime = Math.max(platTime, earn);
    }
    if (plat >= 0) counted[plat][p] = Math.max(track, platTime);
  }
  for (const arr of counted) arr.sort();
  tracked.sort();
  const countBefore = (arr: Float64Array, h: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= h) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Launch-night accounts: the 638 players the page showed before launch, with the trophies they held.
  const launchEarners = launchPage.rates.map((r) => Math.round((r / 100) * launchPage.players_tracked));
  const pageAt = (h: number): { players: number; rates: number[]; earned: number } => {
    const players = launchPage.players_tracked + countBefore(tracked, h);
    const earners = counted.map((arr, j) => launchEarners[j] + countBefore(arr, h));
    return {
      players,
      rates: earners.map((e) => Math.round((10_000 * Math.min(e, players)) / players) / 100),
      earned: earners.reduce((s, e) => s + e, 0),
    };
  };

  // Exophase refreshes: the launch page until about 04:20, then a random cadence.
  const refreshTimes: number[] = [4.2 + 0.3 * rnd()];
  while (refreshTimes[refreshTimes.length - 1] < 175) {
    refreshTimes.push(refreshTimes[refreshTimes.length - 1] + refreshGap * Math.exp(0.6 * normal()) + 0.05);
  }
  const pages = refreshTimes.map((h) => pageAt(h));
  const launchState = { players: launchPage.players_tracked, rates: launchPage.rates, earned: launchEarners.reduce((s, e) => s + e, 0) };
  const lines: string[] = [];
  const startMs = Date.parse('2026-11-18T23:50:00Z');
  const endMs = Date.parse('2026-11-26T01:10:00Z');
  const switchMs = Date.parse('2026-11-19T11:30:00Z');
  let previous = launchState;
  for (let ms = startMs; ms <= endMs; ms += ms < switchMs ? 1_800_000 : 600_000) {
    if (rnd() < 0.02) continue; // a failed read
    const h = (ms - LAUNCH_MS) / 3.6e6 + 1 / 3600;
    let k = -1;
    while (k + 1 < refreshTimes.length && refreshTimes[k + 1] <= h) k++;
    let page = k < 0 ? launchState : pages[k];
    if (k >= 1 && rnd() < staleChance) page = pages[k - 1];
    else previous = page;
    void previous;
    lines.push(
      JSON.stringify({
        slot: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        at: new Date(ms + 300 + Math.floor(rnd() * 200)).toISOString(),
        players_tracked: page.players,
        trophies_earned: page.earned,
        rates: page.rates,
      }),
    );
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'reads.jsonl'), `${lines.join('\n')}\n`);
  writeFileSync(join(out, 'trophies.json'), `${JSON.stringify(trophies, null, 1)}\n`);
  const end = pageAt(144);
  console.log(
    `s${seed}: ${nPlayers} players, gap ${refreshGap.toFixed(2)} h, sync ${syncMean.toFixed(1)} h, ${lines.length} reads; at the target ${end.players} tracked, ch1 ${end.rates[2]}% final ${end.rates[6]}% plat ${end.rates[plat]}%`,
  );
}

main();

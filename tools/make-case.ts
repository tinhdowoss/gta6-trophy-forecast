// Build a case file in the contest's input schema from a local recording, at any cut time and horizon, plus its answer.
//
//   node tools/make-case.ts --data <dir with reads.jsonl + trophies.json> --cut 2026-11-21T11:30:00Z
//        (--target 2026-11-26T00:00:00Z | --horizon-minutes 6510) --id f00 --out <dir> [--recorder-minutes 10]
//
// Writes <out>/input/<id>.in (history = every read whose slot is before the cut, oldest first) and, when the recording
// reaches it, <out>/answers/<id>.json: {"target", "slot", "rates"} from the first read whose slot is in the hour from the
// target, as the contest defines the answer. --recorder-minutes keeps only reads on that clock (10 by default; the
// house's first recorder read every 30).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name: string, dflt?: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DEFAULT_DATA = process.env.FORECAST_DATA ?? fileURLToPath(new URL('../../forecast-data', import.meta.url));
const dataDir = arg('--data', DEFAULT_DATA)!;
const cut = arg('--cut');
if (!cut) throw new Error('--cut is required');
const cutMs = Date.parse(cut);
const targetArg = arg('--target');
const horizon = targetArg ? Math.round((Date.parse(targetArg) - cutMs) / 60_000) : Number(arg('--horizon-minutes', '6510'));
const targetMs = cutMs + horizon * 60_000;
const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
const id = arg('--id', 'x00')!;
const out = arg('--out', join(DEFAULT_DATA, 'cases'))!;
const every = Number(arg('--recorder-minutes', '10'));

interface Read { slot: string; at: string; players_tracked: number; trophies_earned: number | null; rates: Array<number | null> }
const reads: Read[] = readFileSync(join(dataDir, 'reads.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const trophies = JSON.parse(readFileSync(join(dataDir, 'trophies.json'), 'utf8'));
const onClock = (r: Read): boolean => Math.round(Date.parse(r.slot) / 60_000) % every === 0;
const history = reads.filter((r) => Date.parse(r.slot) < cutMs && onClock(r)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
if (history.length === 0) throw new Error('no reads before the cut');

const c = {
  schema: 'makefun/gta6-trophies-case/v1',
  id,
  at: iso(cutMs),
  horizon_minutes: horizon,
  target: iso(targetMs),
  levels: [0.05, 0.25, 0.5, 0.75, 0.95],
  game: { name: 'Grand Theft Auto VI', platform: 'PS5', release_date: '2026-11-19', source: 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/' },
  trophies,
  history: history.map((r) => ({ slot: r.slot, at: r.at, players_tracked: r.players_tracked, trophies_earned: r.trophies_earned, rates: trophies.map((_: unknown, i: number) => r.rates[i] ?? null) })),
  notes: `Built by tools/make-case.ts from ${dataDir}.`,
};
mkdirSync(join(out, 'input'), { recursive: true });
writeFileSync(join(out, 'input', `${id}.in`), JSON.stringify(c));
const answer = reads.find((r) => Date.parse(r.slot) >= targetMs && Date.parse(r.slot) < targetMs + 3_600_000 && r.rates.length >= trophies.length);
if (answer) {
  mkdirSync(join(out, 'answers'), { recursive: true });
  writeFileSync(join(out, 'answers', `${id}.json`), JSON.stringify({ target: c.target, slot: answer.slot, rates: answer.rates }));
}
console.log(`${id}: cut ${c.at}, target ${c.target}, ${history.length} reads${answer ? `, answer from ${answer.slot}` : ', no answer yet'}`);

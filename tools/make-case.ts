// Pseudo-cases shaped like the contest's, cut from a recording (tools/collect.ts or tools/simulate.ts output).
//
//   node tools/make-case.ts --data <dir> --cut <iso> --target <iso> --id <id> --out <dir>
//   node tools/make-case.ts --suite <name> [--cuts final,early,late]          (every recording under <data>/<name>/)
//
// A case holds every read whose slot is before the cut, oldest first; its answer is the first read in the hour from
// the target that lists every trophy, as the contest defines it. Writes <out>/input/<id>.in and <out>/answers/<id>.json
// ({id, target, players_tracked, rates}). Suites go to <forecast-data>/cases/<name>/.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.FORECAST_DATA ?? join(REPO, '..', 'forecast-data');

/** Cut and target pairs: the final's own, the same 4.5 days a day earlier, and a shorter 2.5-day look from the final cut. */
const CUTS: Record<string, { cut: string; target: string }> = {
  final: { cut: '2026-11-21T11:30:00Z', target: '2026-11-26T00:00:00Z' },
  early: { cut: '2026-11-20T11:30:00Z', target: '2026-11-25T00:00:00Z' },
  late: { cut: '2026-11-21T11:30:00Z', target: '2026-11-24T00:00:00Z' },
};

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

interface Read {
  slot: string;
  at: string;
  players_tracked: number;
  trophies_earned: number | null;
  rates: Array<number | null>;
}

function readRecording(dir: string): { trophies: unknown[]; reads: Read[] } {
  const trophies = JSON.parse(readFileSync(join(dir, 'trophies.json'), 'utf8')) as unknown[];
  const reads = readFileSync(join(dir, 'reads.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Read)
    .sort((a, b) => Date.parse(a.slot) - Date.parse(b.slot));
  return { trophies, reads };
}

/** Writes one case and its answer; false when the recording has no answering read. */
function makeCase(dir: string, cut: string, target: string, id: string, out: string): boolean {
  const { trophies, reads } = readRecording(dir);
  const cutMs = Date.parse(cut);
  const targetMs = Date.parse(target);
  const history = reads.filter((r) => Date.parse(r.slot) < cutMs);
  const answer = reads.find((r) => {
    const s = Date.parse(r.slot);
    return s >= targetMs && s < targetMs + 3_600_000 && r.rates.length === trophies.length && r.rates.every((x) => x !== null);
  });
  if (history.length === 0 || !answer) return false;
  const c = {
    schema: 'makefun/gta6-trophies-case/v1',
    id,
    at: cut,
    horizon_minutes: Math.round((targetMs - cutMs) / 60_000),
    target,
    levels: [0.05, 0.25, 0.5, 0.75, 0.95],
    game: {
      name: 'Grand Theft Auto VI',
      platform: 'PS5',
      release_date: '2026-11-19',
      source: 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/',
    },
    trophies,
    history,
    notes: `pseudo-case cut from ${dir}`,
  };
  mkdirSync(join(out, 'input'), { recursive: true });
  mkdirSync(join(out, 'answers'), { recursive: true });
  writeFileSync(join(out, 'input', `${id}.in`), JSON.stringify(c));
  writeFileSync(
    join(out, 'answers', `${id}.json`),
    JSON.stringify({ id, target, players_tracked: answer.players_tracked, rates: answer.rates }),
  );
  return true;
}

function main(): void {
  const suite = argValue('suite', '');
  if (suite) {
    const root = join(DATA, suite);
    const out = join(DATA, 'cases', suite);
    const cuts = argValue('cuts', 'final,early,late').split(',');
    let n = 0;
    for (const name of readdirSync(root).sort()) {
      const dir = join(root, name);
      if (!existsSync(join(dir, 'reads.jsonl'))) continue;
      for (const k of cuts) {
        const spec = CUTS[k];
        if (spec && makeCase(dir, spec.cut, spec.target, `${name}-${k}`, out)) n++;
      }
    }
    console.log(`${suite}: ${n} cases -> ${out}`);
    return;
  }
  const ok = makeCase(
    resolve(argValue('data', DATA)),
    argValue('cut', CUTS.final.cut),
    argValue('target', CUTS.final.target),
    argValue('id', 'f00'),
    resolve(argValue('out', join(DATA, 'cases', 'single'))),
  );
  if (!ok) {
    console.error('no history before the cut or no answering read in the hour from the target');
    process.exit(1);
  }
  console.log('case written');
}

main();

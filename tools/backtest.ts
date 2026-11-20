// Scores main.ts on the pseudo-cases tools/make-case.ts wrote, the way RULES.txt's Scoring section scores an entry,
// beside the two house baselines re-implemented from RULES.txt:
//   persistence  last rate, logit spread 0.5 * sqrt(horizon days);
//   curve        per trophy, least-squares line of logit(rate) on ln(1 + hours since 2026-11-19T00:00Z) over the case's
//                last 24 h of reads, read at the target; spread = random walk's and the fit's residual sd combined;
//                fewer than 3 reads -> persistence.
// Prints loss (mean pinball on the logit scale), typical miss (mean |y - median| in points) and 90% coverage, per
// group of cases (the part of the case name after the world) and overall.
//
//   node tools/backtest.ts [--cases <dir>] [--only final] [--quiet]
//   FORECAST_PARAMS='{"dampLogit":0.7}' node tools/backtest.ts      (tries other numbers in main.ts)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, dflt: string): string => {
  const k = process.argv.indexOf(`--${name}`);
  return k >= 0 && process.argv[k + 1] ? process.argv[k + 1] : dflt;
};
const CASES = resolve(arg('cases', join(repoRoot, '..', 'forecast-data', 'pseudo')));
const ONLY = arg('only', '');
const QUIET = process.argv.includes('--quiet');

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');

interface Case { id: string; at: string; target: string; horizon_minutes: number; trophies: Array<{ id: number }>; history: Array<{ at: string; rates: Array<number | null> }> }
type Rows = Array<{ id: number; q: number[] }>;

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => { const c = clampPct(pct); return Math.log(c / (100 - c)); };
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));

/** RULES.txt's item loss: 2 * max(tau * d, (tau - 1) * d), d = logit(y) - logit(q). */
function score(rows: Rows, c: Case, answer: number[]): { loss: number; items: number; miss: number; covered: number; trophies: number } {
  const byId = new Map(rows.map((r) => [r.id, r.q]));
  let loss = 0, items = 0, miss = 0, covered = 0, trophies = 0;
  c.trophies.forEach((t, i) => {
    const y = answer[i];
    const q = byId.get(t.id);
    if (y === null || y === undefined || !q) return;
    LEVELS.forEach((tau, j) => {
      const d = logit(y) - logit(q[j]);
      loss += 2 * Math.max(tau * d, (tau - 1) * d);
      items++;
    });
    miss += Math.abs(y - q[2]);
    if (q[0] <= y && y <= q[4]) covered++;
    trophies++;
  });
  return { loss, items, miss, covered, trophies };
}

function persistence(c: Case): Rows {
  const last = c.history[c.history.length - 1];
  const s = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return c.trophies.map((t, i) => ({ id: t.id, q: Z.map((z) => fromLogit(logit(last.rates[i] ?? 0) + z * s)) }));
}

function curve(c: Case): Rows {
  const atMs = Date.parse(c.at);
  const recent = c.history.filter((r) => Date.parse(r.at) >= atMs - 24 * 3_600_000);
  const x = (iso: string): number => Math.log(1 + (Date.parse(iso) - LAUNCH_MS) / 3_600_000);
  const xt = x(c.target);
  const rw = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  const base = persistence(c);
  return c.trophies.map((t, i) => {
    const pts = recent.filter((r) => r.rates[i] !== null && r.rates[i] !== undefined);
    if (pts.length < 3) return base[i];
    const xs = pts.map((r) => x(r.at));
    const ys = pts.map((r) => logit(r.rates[i] as number));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxx = 0, sxy = 0;
    xs.forEach((xv, k) => { sxx += (xv - mx) ** 2; sxy += (xv - mx) * (ys[k] - my); });
    const b = sxx > 0 ? sxy / sxx : 0;
    const a = my - b * mx;
    const ssr = xs.reduce((s, xv, k) => s + (ys[k] - (a + b * xv)) ** 2, 0);
    const sd = Math.sqrt(ssr / Math.max(1, pts.length - 2));
    const s = Math.sqrt(rw * rw + sd * sd);
    const m = a + b * xt;
    return { id: t.id, q: Z.map((z) => fromLogit(m + z * s)) };
  });
}

function main(): void {
  const names = readdirSync(CASES).filter((f) => f.endsWith('.in') && (!ONLY || f.includes(ONLY))).sort();
  if (names.length === 0) throw new Error(`no cases in ${CASES}`);
  // One run of main.ts over every case, as the grader would run it (per case), timed.
  const inDir = mkdtempSync(join(tmpdir(), 'bt-in-'));
  const outDir = mkdtempSync(join(tmpdir(), 'bt-out-'));
  for (const f of names) symlinkSync(join(CASES, f), join(inDir, f));
  const t0 = process.hrtime.bigint();
  execFileSync(process.execPath, [join(repoRoot, 'main.ts')], { env: { ...process.env, MAKEFUN_INPUT_DIR: inDir, MAKEFUN_OUTPUT_DIR: outDir }, stdio: ['ignore', 'ignore', 'inherit'] });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  type Acc = { loss: number; items: number; miss: number; covered: number; trophies: number; cases: number };
  const totals = new Map<string, Record<string, Acc>>();
  const add = (group: string, model: string, s: ReturnType<typeof score>): void => {
    for (const g of [group, 'ALL']) {
      const rec = totals.get(g) ?? {};
      const acc = rec[model] ?? { loss: 0, items: 0, miss: 0, covered: 0, trophies: 0, cases: 0 };
      acc.loss += s.loss; acc.items += s.items; acc.miss += s.miss; acc.covered += s.covered; acc.trophies += s.trophies; acc.cases++;
      rec[model] = acc;
      totals.set(g, rec);
    }
  };
  for (const f of names) {
    const c = JSON.parse(readFileSync(join(CASES, f), 'utf8')) as Case;
    const answer = (JSON.parse(readFileSync(join(CASES, f.replace(/\.in$/, '.ans')), 'utf8')) as { rates: number[] }).rates;
    const mine = (JSON.parse(readFileSync(join(outDir, f.replace(/\.in$/, '.out')), 'utf8')) as { trophies: Rows }).trophies;
    const group = f.replace(/\.in$/, '').split('-').slice(1).join('-') || 'case';
    const sMine = score(mine, c, answer), sP = score(persistence(c), c, answer), sC = score(curve(c), c, answer);
    add(group, 'main.ts', sMine); add(group, 'persistence', sP); add(group, 'curve', sC);
    if (!QUIET) console.log(`${f.padEnd(22)} main ${(sMine.loss / sMine.items).toFixed(4)}  persist ${(sP.loss / sP.items).toFixed(4)}  curve ${(sC.loss / sC.items).toFixed(4)}`);
  }
  console.log(`\nmain.ts ran ${names.length} cases in ${ms.toFixed(0)} ms (${(ms / names.length).toFixed(1)} ms a case)`);
  console.log('group      model          cases   loss      typical miss  90% coverage');
  for (const [g, rec] of totals) for (const [m, a] of Object.entries(rec)) {
    console.log(`${g.padEnd(10)} ${m.padEnd(14)} ${String(a.cases).padStart(5)}   ${(a.loss / a.items).toFixed(6)}  ${(a.miss / a.trophies).toFixed(3).padStart(8)} pt  ${(a.covered / a.trophies).toFixed(3)}`);
  }
  if (process.argv.includes('--buckets')) {
    // Loss by the answer's rate band, over the cases scored: where the loss comes from.
    const bands = [0, 0.1, 1, 5, 20, 50, 90, 101];
    const acc = new Map<string, number[]>();
    for (const f of names) {
      const c = JSON.parse(readFileSync(join(CASES, f), 'utf8')) as Case;
      const answer = (JSON.parse(readFileSync(join(CASES, f.replace(/\.in$/, '.ans')), 'utf8')) as { rates: number[] }).rates;
      const mine = (JSON.parse(readFileSync(join(outDir, f.replace(/\.in$/, '.out')), 'utf8')) as { trophies: Rows }).trophies;
      const models: Array<[string, Rows]> = [['main.ts', mine], ['curve', curve(c)], ['persistence', persistence(c)]];
      c.trophies.forEach((t, i) => {
        const y = answer[i];
        const b = bands.findIndex((lo, k) => y >= lo && y < bands[k + 1]);
        for (const [m, rows] of models) {
          const one = score([rows[i]], { ...c, trophies: [t] }, [y]);
          const key = `${bands[b]}-${bands[b + 1]}% ${m}`;
          const v = acc.get(key) ?? [0, 0, 0];
          v[0] += one.loss; v[1] += one.items; v[2] += one.covered;
          acc.set(key, v);
        }
      });
    }
    console.log('\nanswer band   model          items   loss      coverage');
    for (const [k, v] of [...acc].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
      const [band, m] = k.split(' ');
      console.log(`${band.padEnd(13)} ${m.padEnd(14)} ${String(v[1]).padStart(5)}   ${(v[0] / v[1]).toFixed(4)}    ${(v[2] / (v[1] / 5)).toFixed(3)}`);
    }
  }
  rmSync(inDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
}

main();

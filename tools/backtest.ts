// Scores main.ts on pseudo-cases the way the contest scores it, next to the two house baselines.
//
//   node tools/backtest.ts [--suites sim,synthetic] [--params '{"curveMix":0.3}'] [--full] [--bands]
//
// Each suite is <forecast-data>/cases/<suite>/{input,answers} (tools/make-case.ts). Loss: mean over every trophy and
// level of 2 max(tau d, (tau - 1) d), d = logit(y) - logit(q), rates clamped to 0.01..99.99 before the logit. Also
// the typical miss (mean |y - median| in points) and the 90% coverage. --full also runs main.ts a second time to check
// the bytes are identical and times every case on its own.
//
// House baselines, as RULES.txt defines them: persistence (last rate, logit spread 0.5 sqrt(days)); the curve (per
// trophy, least squares of logit(rate) against ln(1 + hours since 2026-11-19T00:00Z) over the last 24 h of reads, read
// at the target; spread the random walk's and the fit's residual combined; under 3 reads, persistence).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.FORECAST_DATA ?? join(REPO, '..', 'forecast-data');
const LAUNCH_MS = Date.parse('2026-11-19T00:00:00Z');
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => Math.log(clampPct(pct) / (100 - clampPct(pct)));
const fromLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Case {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  trophies: Array<{ id: number }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}
type Rows = Map<number, number[]>;

function persistenceRows(c: Case): Rows {
  const last = c.history[c.history.length - 1];
  const s = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return new Map(c.trophies.map((t, i) => [t.id, Z.map((z) => round4(fromLogit(logit(last.rates[i] ?? 0) + z * s)))]));
}

function curveRows(c: Case): Rows {
  const atMs = Date.parse(c.at);
  const recent = c.history.filter((r) => Date.parse(r.at) >= atMs - 86_400_000);
  if (recent.length < 3) return persistenceRows(c);
  const x = (ms: number): number => Math.log(1 + Math.max(0, (ms - LAUNCH_MS) / 3.6e6));
  const xs = recent.map((r) => x(Date.parse(r.at)));
  const xT = x(Date.parse(c.target));
  const rw = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  const last = c.history[c.history.length - 1];
  return new Map(
    c.trophies.map((t, i) => {
      const pts = recent.map((r, k) => [xs[k], r.rates[i]] as const).filter((p) => p[1] !== null) as Array<readonly [number, number]>;
      if (pts.length < 3) return [t.id, Z.map((z) => round4(fromLogit(logit(last.rates[i] ?? 0) + z * rw)))];
      const ys = pts.map((p) => logit(p[1]));
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const my = ys.reduce((s, y) => s + y, 0) / ys.length;
      let sxx = 0;
      let sxy = 0;
      pts.forEach((p, k) => {
        sxx += (p[0] - mx) ** 2;
        sxy += (p[0] - mx) * (ys[k] - my);
      });
      const b = sxx > 0 ? sxy / sxx : 0;
      const a = my - b * mx;
      const resid = Math.sqrt(pts.reduce((s, p, k) => s + (ys[k] - a - b * p[0]) ** 2, 0) / Math.max(1, pts.length - 2));
      const s = Math.sqrt(rw * rw + resid * resid);
      const m = a + b * xT;
      return [t.id, Z.map((z) => round4(fromLogit(m + z * s)))];
    }),
  );
}

interface Score {
  loss: number;
  miss: number;
  cover: number;
  items: number;
  trophies: number;
}
const emptyScore = (): Score => ({ loss: 0, miss: 0, cover: 0, items: 0, trophies: 0 });

function scoreRows(rows: Rows, c: Case, answer: number[], acc: Score, bandAcc?: Score[], lastRates?: number[]): void {
  c.trophies.forEach((t, i) => {
    const q = rows.get(t.id)!;
    const y = answer[i];
    let l = 0;
    LEVELS.forEach((tau, j) => {
      const d = logit(y) - logit(q[j]);
      l += 2 * Math.max(tau * d, (tau - 1) * d);
    });
    for (const a of [acc, bandAcc?.[band(lastRates![i])]]) {
      if (!a) continue;
      a.loss += l;
      a.items += 5;
      a.miss += Math.abs(y - q[2]);
      a.cover += q[0] <= y && y <= q[4] ? 1 : 0;
      a.trophies += 1;
    }
  });
}
const band = (r: number): number => (r < 1 ? 0 : r < 10 ? 1 : r < 60 ? 2 : 3);

function readOutputs(dir: string, cases: Case[]): { rows: Map<string, Rows>; invalid: string[] } {
  const rows = new Map<string, Rows>();
  const invalid: string[] = [];
  for (const c of cases) {
    const f = join(dir, `${c.id}.out`);
    try {
      if (statSync(f).size > 65_536) throw new Error('too large');
      const o = JSON.parse(readFileSync(f, 'utf8')) as { trophies: Array<{ id: number; q: number[] }> };
      if (Object.keys(o).length !== 1 || o.trophies.length !== c.trophies.length) throw new Error('shape');
      const m: Rows = new Map();
      for (const r of o.trophies) {
        if (Object.keys(r).length !== 2 || r.q.length !== 5) throw new Error('row shape');
        if (r.q.some((x, j) => !Number.isFinite(x) || x < 0 || x > 100 || (j > 0 && x < r.q[j - 1]))) throw new Error('q');
        m.set(r.id, r.q);
      }
      if (c.trophies.some((t) => !m.has(t.id))) throw new Error('missing id');
      rows.set(c.id, m);
    } catch {
      invalid.push(c.id);
      const last = c.history[c.history.length - 1];
      rows.set(c.id, new Map(c.trophies.map((t, i) => [t.id, new Array(5).fill(last.rates[i] ?? 0)])));
    }
  }
  return { rows, invalid };
}

function runMain(inputDir: string, params: string): { dir: string; ms: number } {
  const dir = mkdtempSync(join(tmpdir(), 'gta6-bt-'));
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [join(REPO, 'main.ts')], {
    env: { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: dir, FORECAST_PARAMS: params, FORECAST_DEBUG: '' },
    encoding: 'utf8',
  });
  if (r.status !== 0) console.error(r.stderr);
  return { dir, ms: performance.now() - t0 };
}

const fmt = (s: Score): string =>
  `${(s.loss / Math.max(1, s.items)).toFixed(4)}  ${(s.miss / Math.max(1, s.trophies)).toFixed(2).padStart(6)}  ${(s.cover / Math.max(1, s.trophies)).toFixed(3)}`;

function main(): void {
  const suites = argValue('suites', 'sim,synthetic').split(',');
  const params = argValue('params', '{}');
  const total = { model: emptyScore(), persistence: emptyScore(), curve: emptyScore() };
  console.log('suite/cut                 cases | main.ts loss miss cover | persistence loss miss cover | curve loss miss cover');
  for (const suite of suites) {
    const root = join(DATA, 'cases', suite);
    if (!existsSync(join(root, 'input'))) {
      console.log(`${suite}: no cases (run tools/make-case.ts --suite ${suite})`);
      continue;
    }
    const files = readdirSync(join(root, 'input')).filter((f) => f.endsWith('.in')).sort();
    const cases = files.map((f) => JSON.parse(readFileSync(join(root, 'input', f), 'utf8')) as Case);
    const run = runMain(join(root, 'input'), params);
    const { rows, invalid } = readOutputs(run.dir, cases);
    if (flag('full')) {
      const again = runMain(join(root, 'input'), params);
      const same = cases.every((c) => readFileSync(join(run.dir, `${c.id}.out`)).equals(readFileSync(join(again.dir, `${c.id}.out`))));
      let worst = 0;
      for (const c of cases) {
        const one = mkdtempSync(join(tmpdir(), 'gta6-one-'));
        copyFileSync(join(root, 'input', `${c.id}.in`), join(one, `${c.id}.in`));
        const t = runMain(one, params);
        worst = Math.max(worst, t.ms);
        rmSync(one, { recursive: true });
        rmSync(t.dir, { recursive: true });
      }
      console.log(`${suite}: deterministic ${same}, invalid ${invalid.length}, slowest case ${worst.toFixed(0)} ms (node start included)`);
      rmSync(again.dir, { recursive: true });
    } else if (invalid.length > 0) {
      console.log(`${suite}: INVALID ${invalid.join(' ')}`);
    }
    const groups = new Map<string, { model: Score; persistence: Score; curve: Score; n: number; bands: Score[] }>();
    for (const c of cases) {
      const answer = (JSON.parse(readFileSync(join(root, 'answers', `${c.id}.json`), 'utf8')) as { rates: number[] }).rates;
      const kind = c.id.split('-').pop() ?? 'all';
      if (!groups.has(kind)) groups.set(kind, { model: emptyScore(), persistence: emptyScore(), curve: emptyScore(), n: 0, bands: [0, 1, 2, 3].map(emptyScore) });
      const g = groups.get(kind)!;
      g.n++;
      const lastRates = c.history[c.history.length - 1].rates.map((r) => r ?? 0);
      scoreRows(rows.get(c.id)!, c, answer, g.model, g.bands, lastRates);
      scoreRows(persistenceRows(c), c, answer, g.persistence);
      scoreRows(curveRows(c), c, answer, g.curve);
      scoreRows(rows.get(c.id)!, c, answer, total.model);
      scoreRows(persistenceRows(c), c, answer, total.persistence);
      scoreRows(curveRows(c), c, answer, total.curve);
    }
    for (const [kind, g] of [...groups].sort()) {
      console.log(`${`${suite}/${kind}`.padEnd(25)} ${String(g.n).padStart(5)} | ${fmt(g.model)} | ${fmt(g.persistence)} | ${fmt(g.curve)}`);
      if (flag('bands')) {
        g.bands.forEach((b, k) => b.trophies > 0 && console.log(`   band ${['<1%', '1-10%', '10-60%', '>=60%'][k].padEnd(7)} n=${String(b.trophies).padStart(4)} ${fmt(b)}`));
      }
    }
    rmSync(run.dir, { recursive: true });
  }
  console.log(`${'ALL'.padEnd(25)}       | ${fmt(total.model)} | ${fmt(total.persistence)} | ${fmt(total.curve)}`);
}

main();

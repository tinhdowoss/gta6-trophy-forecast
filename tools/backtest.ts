// Score main.ts like the contest's scorer, beside the two house baselines, on the practice cases and on pseudo-cases.
//
//   node tools/backtest.ts [--suites practice,synthetic,real] [--seeds 1-12] [--tune '{"RECENCY_L":0.6}'] [--quiet]
//
// Loss: mean over trophies and the 5 levels of 2*max(tau*d, (tau-1)*d), d = logit(y) - logit(q), percents clamped to
// 0.01..99.99. Also the typical miss (mean |y - median|, points) and the 90% coverage (q05 <= y <= q95).
//   practice:  the kit's p00/p01; their answers are not in the kit, so only validity, run time and determinism are checked
//   synthetic: forecast-data/synthetic/s<seed>/ (tools/simulate.ts), cut like the final (2026-11-21T11:30Z -> 11-26T00:00Z)
//              and a day earlier (2026-11-20T11:30Z -> 11-25T00:00Z)
//   real:      forecast-data/reads.jsonl (tools/collect.ts), every cut that leaves a 6,510-minute horizon inside it
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.FORECAST_DATA ?? '/Users/tinhdo/Downloads/makefun/forecast-data';
const KIT_INPUT = '/Users/tinhdo/Downloads/makefun/kit-forecast/gta6-trophy-rarity-forecast-01-kit/input';
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

const args = process.argv.slice(2);
const arg = (n: string, d: string): string => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const suites = arg('--suites', 'practice,synthetic,real').split(',');
const [s0, s1] = arg('--seeds', '1-12').split('-').map(Number);
const tune = arg('--tune', '');
const quiet = args.includes('--quiet');

const clamp = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => { const p = clamp(pct) / 100; return Math.log(p / (1 - p)); };
const inv = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

interface Row { id: number; q: number[] }
interface Case { id: string; at: string; target: string; horizon_minutes: number; trophies: Array<{ id: number }>; history: Array<{ at: string; rates: Array<number | null> }> }

function validRows(rows: unknown, c: Case): rows is Row[] {
  if (!Array.isArray(rows) || rows.length !== c.trophies.length) return false;
  const ids = new Set(c.trophies.map((t) => t.id));
  for (const r of rows as Row[]) {
    if (!ids.delete(r.id) || !Array.isArray(r.q) || r.q.length !== 5) return false;
    for (let j = 0; j < 5; j++) if (!Number.isFinite(r.q[j]) || r.q[j] < 0 || r.q[j] > 100 || (j > 0 && r.q[j] < r.q[j - 1])) return false;
  }
  return ids.size === 0;
}

/** The house baseline: persistence, logit spread 0.5 sqrt(days). */
function persistence(c: Case): Row[] {
  const last = c.history[c.history.length - 1];
  const s = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return c.trophies.map((t, i) => ({ id: t.id, q: Z.map((z) => round4(inv(logit(last.rates[i] ?? 0) + z * s))) }));
}

/** The house curve baseline, as RULES describes it: per trophy, least squares of logit vs ln(1 + hours since 11-19
 * 00:00Z) over the last 24 h of reads, read at the target; spread = random walk's and the fit's residual combined. */
function curve(c: Case): Row[] {
  const cutMs = Date.parse(c.at);
  const recent = c.history.filter((r) => Date.parse(r.at) >= cutMs - 24 * 3_600_000);
  if (recent.length < 3) return persistence(c);
  const x0 = Date.parse('2026-11-19T00:00:00Z');
  const xOf = (ms: number): number => Math.log(1 + Math.max(0, (ms - x0) / 3_600_000));
  const xT = xOf(Date.parse(c.target));
  const rw = 0.5 * Math.sqrt(c.horizon_minutes / 1440);
  return c.trophies.map((t, i) => {
    const pts = recent.filter((r) => r.rates[i] !== null).map((r) => [xOf(Date.parse(r.at)), logit(r.rates[i]!)]);
    if (pts.length < 3) return persistence(c)[i];
    const n = pts.length, mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
    const sxx = pts.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    const b = sxx > 0 ? pts.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : 0;
    const a = my - b * mx;
    const res = Math.sqrt(pts.reduce((acc, p) => acc + (p[1] - a - b * p[0]) ** 2, 0) / Math.max(1, n - 2));
    const s = Math.sqrt(rw * rw + res * res);
    return { id: t.id, q: Z.map((z) => round4(inv(a + b * xT + z * s))) };
  });
}

interface Score { loss: number; miss: number; cover: number; n: number }
const BAND_NAMES = ['0.00', '<0.1', '0.1-1', '1-10', '10-50', '>50'];
const bandOfRate = (r: number): number => (r <= 0 ? 0 : r < 0.1 ? 1 : r < 1 ? 2 : r < 10 ? 3 : r < 50 ? 4 : 5);
/** Pinball-loss sums by the band of each trophy's last rate in the case: [sum, count] per band, per model name. */
const bandLoss = new Map<string, Array<[number, number]>>();
function score(rows: Row[], c: Case, answer: Array<number | null>, model = ''): Score {
  let loss = 0, miss = 0, cover = 0, n = 0, items = 0;
  const byId = new Map(rows.map((r) => [r.id, r.q]));
  const bands = bandLoss.get(model) ?? BAND_NAMES.map((): [number, number] => [0, 0]);
  bandLoss.set(model, bands);
  const last = c.history[c.history.length - 1].rates;
  c.trophies.forEach((t, i) => {
    const y = answer[i];
    if (y === null || y === undefined) return;
    const q = byId.get(t.id)!;
    let li = 0;
    LEVELS.forEach((tau, j) => { const d = logit(y) - logit(q[j]); li += 2 * Math.max(tau * d, (tau - 1) * d); items++; });
    loss += li;
    const b = bands[bandOfRate(last[i] ?? 0)]; b[0] += li / 5; b[1]++;
    miss += Math.abs(y - q[2]); cover += q[0] <= y && y <= q[4] ? 1 : 0; n++;
  });
  return { loss: loss / items, miss: miss / n, cover: cover / n, n };
}

/** Run main.ts on one input directory; returns each case's rows (or null when invalid) and the wall time. */
function runMain(inputDir: string): { out: Map<string, unknown>; ms: number; outDir: string } {
  const outDir = mkdtempSync(join(tmpdir(), 'gta6bt-'));
  const env = { ...process.env, MAKEFUN_INPUT_DIR: inputDir, MAKEFUN_OUTPUT_DIR: outDir, ...(tune ? { FORECAST_TUNE: tune } : {}) };
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [join(ROOT, 'main.ts')], { env, encoding: 'utf8' });
  const ms = performance.now() - t0;
  if (r.status !== 0) console.error(r.stderr);
  const out = new Map<string, unknown>();
  for (const f of readdirSync(outDir)) {
    try { out.set(f.replace(/\.out$/, ''), JSON.parse(readFileSync(join(outDir, f), 'utf8')).trophies); } catch { out.set(f.replace(/\.out$/, ''), null); }
  }
  return { out, ms, outDir };
}

interface Tally { loss: number[]; miss: number[]; cover: number[] }
const tally = (): Tally => ({ loss: [], miss: [], cover: [] });
const add = (t: Tally, s: Score): void => { t.loss.push(s.loss); t.miss.push(s.miss); t.cover.push(s.cover); };
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

function scoreSuite(name: string, dir: string): void {
  const inputDir = join(dir, 'input');
  const cases = readdirSync(inputDir).filter((f) => f.endsWith('.in')).sort();
  const { out, ms, outDir } = runMain(inputDir);
  const again = runMain(inputDir);
  let identical = true;
  for (const f of readdirSync(outDir)) {
    if (readFileSync(join(outDir, f), 'utf8') !== readFileSync(join(again.outDir, f), 'utf8')) identical = false;
  }
  rmSync(outDir, { recursive: true, force: true }); rmSync(again.outDir, { recursive: true, force: true });
  const T = { main: tally(), persistence: tally(), curve: tally() };
  let valid = 0, scored = 0;
  for (const f of cases) {
    const id = f.slice(0, -3);
    const c = JSON.parse(readFileSync(join(inputDir, f), 'utf8')) as Case;
    const rows = out.get(id);
    const ok = validRows(rows, c);
    if (ok) valid++;
    const ansFile = join(dir, 'answers', `${id}.json`);
    if (!existsSync(ansFile)) continue;
    const ans = JSON.parse(readFileSync(ansFile, 'utf8')).rates as Array<number | null>;
    scored++;
    const sm = score(ok ? (rows as Row[]) : c.trophies.map((t, i) => ({ id: t.id, q: Array(5).fill(c.history[c.history.length - 1].rates[i] ?? 0) })), c, ans, 'main');
    const sp = score(persistence(c), c, ans, 'persistence'), sc = score(curve(c), c, ans, 'curve');
    add(T.main, sm); add(T.persistence, sp); add(T.curve, sc);
    const group = `main ${name}${/[a-z]$/.test(id) ? ` cut-${id.slice(-1)}` : ''}`;
    const g = groupTallies.get(group) ?? tally(); add(g, sm); groupTallies.set(group, g);
    if (!quiet) console.log(`  ${name} ${id}: main ${sm.loss.toFixed(4)} cov ${sm.cover.toFixed(2)} | persist ${sp.loss.toFixed(4)} | curve ${sc.loss.toFixed(4)}`);
  }
  console.log(`\n${name}: ${cases.length} cases, ${valid} valid, deterministic ${identical ? 'yes' : 'NO'}, main.ts ${(ms / Math.max(1, cases.length)).toFixed(0)} ms/case (one process, all cases)`);
  if (scored === 0) { console.log('  no answers available: validity only'); return; }
  console.log('  model          loss     typical-miss  90%-coverage');
  for (const [k, t] of Object.entries(T)) console.log(`  ${k.padEnd(13)} ${mean(t.loss).toFixed(4)}   ${mean(t.miss).toFixed(3).padStart(8)}    ${mean(t.cover).toFixed(3)}`);
  for (const [k, t] of groupTallies) if (k.startsWith(`main ${name} `)) console.log(`  ${k.padEnd(28)} loss ${mean(t.loss).toFixed(4)}  coverage ${mean(t.cover).toFixed(3)}`);
  console.log(`  mean item loss by last-rate band (${BAND_NAMES.join(' | ')}), trophies per band:`);
  for (const [k, b] of bandLoss) console.log(`  ${k.padEnd(13)} ${b.map(([s, n]) => (n ? (s / n).toFixed(3) : '  -  ').padStart(6)).join(' ')}   n=${b.map(([, n]) => n).join('/')}`);
  bandLoss.clear();
}
const groupTallies = new Map<string, Tally>();

function buildCases(dataDir: string, outDir: string, cuts: Array<[string, string, string]>): number {
  let n = 0;
  for (const [id, cut, target] of cuts) {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'make-case.ts'), '--data', dataDir, '--cut', cut, '--target', target, '--id', id, '--out', outDir], { encoding: 'utf8' });
    if (r.status === 0) n++; else if (!quiet) console.error(r.stderr.trim().split('\n').pop());
  }
  return n;
}

if (suites.includes('practice')) scoreSuite('practice', join(KIT_INPUT, '..'));

if (suites.includes('synthetic')) {
  const dir = join(DATA, 'cases', 'synthetic');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (let s = s0; s <= s1; s++) {
    const d = join(DATA, 'synthetic', `s${s}`);
    if (!existsSync(join(d, 'reads.jsonl'))) continue;
    buildCases(d, dir, [
      [`s${String(s).padStart(2, '0')}a`, '2026-11-21T11:30:00Z', '2026-11-26T00:00:00Z'],
      [`s${String(s).padStart(2, '0')}b`, '2026-11-20T11:30:00Z', '2026-11-25T00:00:00Z'],
    ]);
  }
  scoreSuite('synthetic', dir);
}

if (suites.includes('real')) {
  const reads = join(DATA, 'reads.jsonl');
  if (!existsSync(reads)) console.log('\nreal: no forecast-data/reads.jsonl yet (tools/collect.ts)');
  else {
    const lines = readFileSync(reads, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { slot: string });
    const first = Date.parse(lines[0].slot), last = Date.parse(lines[lines.length - 1].slot);
    const cuts: Array<[string, string, string]> = [];
    for (let ms = first + 6 * 3_600_000; ms + 6510 * 60_000 <= last; ms += 6 * 3_600_000) {
      cuts.push([`r${cuts.length}`, new Date(ms).toISOString(), new Date(ms + 6510 * 60_000).toISOString()]);
    }
    if (cuts.length === 0) console.log(`\nreal: ${lines.length} reads, not yet 4.5 days of them: no pseudo-case has an answer`);
    else {
      const dir = join(DATA, 'cases', 'real');
      rmSync(dir, { recursive: true, force: true });
      buildCases(DATA, dir, cuts);
      scoreSuite('real', dir);
    }
  }
}

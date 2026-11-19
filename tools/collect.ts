// One polite read of Exophase's GTA VI (PS5) trophy page, appended to the local recording in the case-history shape.
//
//   node tools/collect.ts                 fetch the page once, save the raw HTML, parse it, append one read
//   node tools/collect.ts --html <file>   parse a saved page instead (no network), append nothing unless --append
//
// Output (outside the repository): $FORECAST_DATA or /Users/tinhdo/Downloads/makefun/forecast-data
//   reads.jsonl     one JSON line per read: {slot, at, players_tracked, trophies_earned, rates}
//   trophies.json   the trophy list in Exophase order: [{id, name, description, tier, points, secret}]
//   raw/<stamp>.html the page as fetched
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const URL_ = 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/';
const DATA_DIR = process.env.FORECAST_DATA ?? '/Users/tinhdo/Downloads/makefun/forecast-data';
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];
const POINTS: Record<string, number> = { platinum: 300, gold: 90, silver: 30, bronze: 15 };

interface Trophy { id: number; name: string; description: string; tier: string; points: number; secret: boolean }
interface Parsed { players_tracked: number; trophies_earned: number | null; trophies: Trophy[]; rates: number[]; total: number | null }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&hellip;/g, '…').replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&amp;/g, '&');
}
const text = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const num = (s: string): number => Number(s.replace(/[,\s]/g, ''));

/** Pull a labelled count out of the page text, e.g. "12,345 Players" or "Players Tracked 12,345". */
function findCount(plain: string, labels: string[]): number | null {
  for (const label of labels) {
    const after = new RegExp(`${label}\\s*:?\\s*([\\d,]+)`, 'i').exec(plain);
    if (after) return num(after[1]);
    const before = new RegExp(`([\\d,]+)\\s*${label}`, 'i').exec(plain);
    if (before) return num(before[1]);
  }
  return null;
}

/** Parse the trophy list: each trophy is an <li> carrying its tier class, a title, a description and a rarity "x.xx%". */
export function parsePage(html: string): Parsed {
  const plain = text(html);
  const players = findCount(plain, ['Players Tracked', 'Players', 'Gamers Tracked', 'Owners']);
  if (players === null) throw new Error('players tracked not found');
  const earned = findCount(plain, ['Trophies Earned', 'Achievements Earned', 'Earned']);
  const total = findCount(plain, ['Total Trophies', 'Trophies']);

  const trophies: Trophy[] = [];
  const rates: number[] = [];
  // Every list item that carries an award id is one trophy.
  const itemRe = /<li\b[^>]*\bdata-award-id="?\d+"?[^>]*>([\s\S]*?)(?=<li\b[^>]*\bdata-award-id=|<\/ul>)/g;
  for (let m = itemRe.exec(html); m; m = itemRe.exec(html)) {
    const open = m[0].slice(0, m[0].indexOf('>') + 1);
    const body = m[1];
    const tierMatch = /(platinum|gold|silver|bronze)/i.exec(open) ?? /award-(platinum|gold|silver|bronze)|trophy-(platinum|gold|silver|bronze)|\b(platinum|gold|silver|bronze)\b/i.exec(body);
    const tier = (tierMatch ? (tierMatch[1] ?? tierMatch[2] ?? tierMatch[3] ?? tierMatch[4]) : 'bronze').toLowerCase();
    const title = /<a[^>]*>([\s\S]*?)<\/a>/.exec(/<h3[\s\S]*?<\/h3>|<div class="award-title"[\s\S]*?<\/div>/.exec(body)?.[0] ?? body);
    const desc = /<div class="award-description"[^>]*>([\s\S]*?)<\/div>/.exec(body);
    const rate = /([\d.]+)%/.exec(text(/class="[^"]*(?:rarity|percent|award-earned)[^"]*"[^>]*>([\s\S]*?)<\/(?:span|div)>/.exec(body)?.[0] ?? body));
    if (!title || !rate) continue;
    trophies.push({
      id: trophies.length + 1,
      name: text(title[1]),
      description: desc ? text(desc[1]) : '',
      tier,
      points: POINTS[tier] ?? 15,
      secret: /\bsecret\b|hidden/i.test(open),
    });
    rates.push(Number(rate[1]));
  }
  if (trophies.length === 0) throw new Error('no trophies parsed');
  return { players_tracked: players, trophies_earned: earned, trophies, rates, total };
}

async function fetchOnce(ua: string): Promise<{ status: number; html: string }> {
  const res = await fetch(URL_, {
    headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  return { status: res.status, html: await res.text() };
}

function slotOf(d: Date): string {
  const s = new Date(Math.floor(d.getTime() / 600_000) * 600_000);
  return s.toISOString().replace('.000Z', 'Z');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const htmlArg = args.indexOf('--html');
  mkdirSync(join(DATA_DIR, 'raw'), { recursive: true });
  let html: string;
  let at = new Date();
  let append = true;
  if (htmlArg >= 0) {
    html = readFileSync(args[htmlArg + 1], 'utf8');
    append = args.includes('--append');
    const stamp = /(\d{8}T\d{6}Z)/.exec(args[htmlArg + 1]);
    if (stamp) at = new Date(stamp[1].replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z'));
  } else {
    let r = await fetchOnce(USER_AGENTS[0]);
    if (r.status === 403 || r.status === 429 || r.status === 503) {
      console.error(`status ${r.status} with the first User-Agent; one retry with another`);
      r = await fetchOnce(USER_AGENTS[1]);
    }
    at = new Date();
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z/, 'Z');
    writeFileSync(join(DATA_DIR, 'raw', `${stamp}.html`), r.html);
    if (r.status !== 200) throw new Error(`Exophase answered ${r.status}`);
    html = r.html;
  }
  const p = parsePage(html);
  if (p.total !== null && p.total !== p.trophies.length) console.error(`warning: page says ${p.total} trophies, parsed ${p.trophies.length}`);
  const read = { slot: slotOf(at), at: at.toISOString(), players_tracked: p.players_tracked, trophies_earned: p.trophies_earned, rates: p.rates };
  if (append) {
    appendFileSync(join(DATA_DIR, 'reads.jsonl'), `${JSON.stringify(read)}\n`);
    writeFileSync(join(DATA_DIR, 'trophies.json'), `${JSON.stringify(p.trophies, null, 1)}\n`);
  }
  console.log(`${read.at} players ${p.players_tracked} earned ${p.trophies_earned} trophies ${p.trophies.length}${append ? ' (appended)' : ''}`);
  for (const [i, t] of p.trophies.entries()) console.log(`${String(t.id).padStart(2)} ${t.tier.padEnd(8)} ${p.rates[i].toFixed(2).padStart(6)}%  ${t.name}`);
}

main().catch((e) => { console.error(String(e?.stack ?? e)); process.exit(1); });

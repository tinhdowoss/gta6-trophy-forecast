// One polite read of Exophase's GTA VI (PS5) trophy page, stored the way a case's history stores a read.
//
//   node tools/collect.ts [--data <dir>] [--url <page>]
//
// Appends one line {slot, at, players_tracked, trophies_earned, rates} to <data>/reads.jsonl and writes the trophy list
// ({id, name, description, tier, points, secret}, in page order) to <data>/trophies.json. The page as fetched is kept
// under <data>/raw/ so a parse can be checked. Exactly one request per run, no retries: schedule it (for example every
// 30 minutes) rather than looping. Data lives outside the repository (default: ../forecast-data beside it).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/';
const POINTS: Record<string, number> = { platinum: 300, gold: 90, silver: 30, bronze: 15 };

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const toInt = (s: string): number => Number(s.replace(/[^\d]/g, ''));

interface ParsedTrophy {
  name: string;
  description: string;
  tier: string;
  secret: boolean;
  rate: number;
}

/** Pulls every trophy (name, description, tier, rate) and the header counts out of the page. */
function parsePage(html: string): { trophies: ParsedTrophy[]; players: number; earned: number | null; total: number | null } {
  const trophies: ParsedTrophy[] = [];
  // Each trophy is a list item carrying an award title, an award description and its rarity "x.xx%".
  for (const m of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const attrs = m[1];
    const body = m[2];
    if (!/award/i.test(attrs + body)) continue;
    const title = /class="[^"]*award-title[^"]*"[^>]*>([\s\S]*?)<\/(?:div|a|h\d|span)>/i.exec(body);
    const desc = /class="[^"]*award-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body);
    const rate = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(stripTags(body.replace(/award-description[\s\S]*?<\/div>/i, '')));
    if (!title || !rate) continue;
    const tierMatch = /(platinum|gold|silver|bronze)/i.exec(attrs + body);
    trophies.push({
      name: stripTags(title[1]),
      description: desc ? stripTags(desc[1]) : '',
      tier: tierMatch ? tierMatch[1].toLowerCase() : 'bronze',
      secret: /secret|hidden/i.test(attrs),
      rate: Number(rate[1]),
    });
  }
  const text = stripTags(html);
  const players = /([\d,]+)\s*players?\s*tracked/i.exec(text) ?? /players?\s*tracked\D{0,40}([\d,]+)/i.exec(text);
  const earned = /([\d,]+)\s*trophies\s*earned/i.exec(text) ?? /trophies\s*earned\D{0,40}([\d,]+)/i.exec(text);
  const total = /total\s*trophies\D{0,40}(\d+)/i.exec(text);
  return {
    trophies,
    players: players ? toInt(players[1]) : NaN,
    earned: earned ? toInt(earned[1]) : null,
    total: total ? Number(total[1]) : null,
  };
}

/** The house's clock slot a read falls in: the start of its 10-minute slot. */
function slotOf(ms: number): string {
  return new Date(Math.floor(ms / 600_000) * 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function main(): Promise<void> {
  const data = resolve(argValue('data', process.env.FORECAST_DATA ?? join(REPO, '..', 'forecast-data')));
  const url = argValue('url', PAGE);
  mkdirSync(join(data, 'raw'), { recursive: true });
  const started = Date.now();
  const stamp = new Date(started).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await res.text();
  writeFileSync(join(data, 'raw', `${stamp}.html`), html);
  const log = (line: string): void => appendFileSync(join(data, 'collect.log'), `${new Date().toISOString()} ${line}\n`);
  if (!res.ok) {
    log(`HTTP ${res.status} (${html.length} bytes, ${/Just a moment/i.test(html) ? 'Cloudflare challenge' : 'no page'}); nothing appended`);
    throw new Error(`Exophase answered HTTP ${res.status}; raw response kept as raw/${stamp}.html`);
  }
  const page = parsePage(html);
  if (page.trophies.length === 0 || !Number.isFinite(page.players)) {
    log(`page did not parse (${page.trophies.length} trophies, players ${page.players}); nothing appended`);
    throw new Error('the page did not parse whole; raw page kept for inspection');
  }
  if (page.total !== null && page.total !== page.trophies.length) {
    log(`page lists ${page.trophies.length} trophies but says ${page.total}; nothing appended`);
    throw new Error('incomplete page');
  }
  // Keep the id order stable: ids follow trophies.json when it exists, new names are appended.
  const listPath = join(data, 'trophies.json');
  const known: Array<{ id: number; name: string; description: string; tier: string; points: number; secret: boolean }> =
    existsSync(listPath) ? JSON.parse(readFileSync(listPath, 'utf8')) : [];
  for (const t of page.trophies) {
    if (!known.some((k) => k.name === t.name)) {
      known.push({ id: known.length + 1, name: t.name, description: t.description, tier: t.tier, points: POINTS[t.tier] ?? 15, secret: t.secret });
    }
  }
  writeFileSync(listPath, `${JSON.stringify(known, null, 1)}\n`);
  const rates = known.map((k) => page.trophies.find((t) => t.name === k.name)?.rate ?? null);
  const read = {
    slot: slotOf(started),
    at: new Date(started).toISOString(),
    players_tracked: page.players,
    trophies_earned: page.earned,
    rates,
  };
  appendFileSync(join(data, 'reads.jsonl'), `${JSON.stringify(read)}\n`);
  log(`ok: ${page.trophies.length} trophies, ${page.players} players tracked`);
  console.log(`appended a read: ${page.players} players tracked, ${page.trophies.length} trophies -> ${data}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

// One polite read of Exophase's GTA VI (PS5) trophy page. On success it appends one line shaped like a case's history
// entry ({slot, at, players_tracked, trophies_earned, rates}) to forecast-data/reads.jsonl and writes the trophy list
// (in page order, shaped like a case's `trophies`) to forecast-data/trophies.json. One request, no retries, so it
// never hammers the site; run it on a schedule of your own at most every 30 minutes.
//
//   node tools/collect.ts [dataDir]      (dataDir defaults to ../forecast-data beside the repository)

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_PAGE = 'https://www.exophase.com/game/grand-theft-auto-vi-psn/trophies/';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.argv[2] ?? join(repoRoot, '..', 'forecast-data'));

interface ParsedTrophy { name: string; description: string; tier: string; rate: number }

const decode = (s: string): string => s
  .replace(/<[^>]*>/g, '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
  .replace(/\s+/g, ' ').trim();

/** Pull every trophy (name, description, tier, rarity %) and the players-tracked count out of the page's HTML. */
function parsePage(html: string): { players: number; earned: number | null; trophies: ParsedTrophy[] } {
  const players = /([\d,]+)\s*(?:<[^>]*>\s*)*Players? Tracked/i.exec(html) ?? /Players? Tracked\D{0,200}?([\d,]+)/i.exec(html);
  if (!players) throw new Error('players tracked not found');
  const earnedM = /([\d,]+)\s*(?:<[^>]*>\s*)*Trophies Earned/i.exec(html);
  const trophies: ParsedTrophy[] = [];
  // Each trophy is a list item carrying its tier class; inside it, the title link, the description and "x.xx%".
  const itemRe = /<li[^>]*class="[^"]*\b(platinum|gold|silver|bronze)\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  for (let m = itemRe.exec(html); m; m = itemRe.exec(html)) {
    const body = m[2];
    const name = /<a[^>]*>([\s\S]*?)<\/a>/i.exec(body);
    const desc = /<div[^>]*class="[^"]*award-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body)
      ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(body);
    const rate = /([\d.]+)\s*%/.exec(decode(body.replace(/<a[\s\S]*?<\/a>/gi, ' ')));
    if (!name || !rate) continue;
    trophies.push({ name: decode(name[1]), description: desc ? decode(desc[1]) : '', tier: m[1].toLowerCase(), rate: Number(rate[1]) });
  }
  const total = /Total Trophies\D{0,200}?(\d+)/i.exec(html);
  if (trophies.length === 0) throw new Error('no trophies parsed');
  if (total && Number(total[1]) !== trophies.length) throw new Error(`parsed ${trophies.length} trophies, page says ${total[1]}`);
  return { players: Number(players[1].replace(/,/g, '')), earned: earnedM ? Number(earnedM[1].replace(/,/g, '')) : null, trophies };
}

async function main(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const at = new Date();
  const slot = new Date(Math.floor(at.getTime() / 1_800_000) * 1_800_000);
  const res = await fetch(URL_PAGE, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(20_000),
  });
  const html = await res.text();
  if (!res.ok) {
    const note = /cloudflare|cf-chl|challenge/i.test(html) ? ', Cloudflare challenge' : '';
    appendFileSync(join(dataDir, 'collect.log'), `${at.toISOString()} HTTP ${res.status} (${html.length} bytes${note}); nothing appended\n`);
    throw new Error(`Exophase answered HTTP ${res.status}${note}`);
  }
  const page = parsePage(html);
  const line = {
    slot: slot.toISOString().replace('.000Z', 'Z'),
    at: at.toISOString(),
    players_tracked: page.players,
    trophies_earned: page.earned,
    rates: page.trophies.map((t) => t.rate),
  };
  appendFileSync(join(dataDir, 'reads.jsonl'), `${JSON.stringify(line)}\n`);
  writeFileSync(join(dataDir, 'trophies.json'), `${JSON.stringify(page.trophies.map((t, i) => ({ id: i + 1, name: t.name, description: t.description, tier: t.tier })), null, 1)}\n`);
  appendFileSync(join(dataDir, 'collect.log'), `${at.toISOString()} ok: ${page.players} players, ${page.trophies.length} trophies\n`);
  console.log(`appended a read: ${page.players} players tracked, ${page.trophies.length} trophies`);
}

main().catch((err: unknown) => { console.error(String(err)); process.exitCode = 1; });

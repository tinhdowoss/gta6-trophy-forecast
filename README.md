# GTA VI trophy rarity forecast: refresh-aware earners / players forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts five quantiles of every Grand Theft Auto VI (PS5) trophy's earn rate on Exophase at the target time of a
case, scored by pinball loss on the logit scale.

## Method

A rate on Exophase is earners / players tracked, and the page only changes when Exophase refreshes its counts. When it
refreshes, players tracked jumps (new, mostly casual players), so most rates fall even while earner counts grow.
`main.ts` therefore models the two counts separately:

1. **Refreshes.** `dedupeRefreshes` reduces the house's reads to distinct page states. A stale cache that serves an
   older page again is ignored. Each refresh is dated between the reads that bracket it, and
   `estimateRefreshCadence` gives the typical gap. The forecast is for the last refresh expected before the target
   (target minus half a gap).
2. **Counts.** `toEarnerCounts`: earners = rate / 100 × players tracked. The 2-decimal rounding of the page is carried
   into the fit weights, so thin trophies count for less.
3. **Log-time slopes.** In u = ln(1 + hours since 2026-11-19T00:00Z), `measureSlopes` takes the recent slope of ln
   players tracked, of each trophy's ln earners and of its logit rate. The slopes of thin trophies (few earners, or
   none yet) are shrunk toward a cross-sectional curve of slope against rate: a rare trophy grows like other rare
   trophies.
4. **Saturating growth.** `forecastPlayersTracked` and `forecastEarners` extrapolate with slopes that decay in
   log-time, as slope × (1 − e^(−k·Δu)) / k. The decays k of players and of earners are chosen **inside each case**:
   the history is cut at earlier moments, each cut forecasts a later refresh about the real log-time horizon ahead,
   and the k with the smallest error wins, pulled toward a prior of k ≈ 1. On simulated weeks, the slope realized
   over the final's horizon was about 0.55–0.7 of the slope at the cut.
5. **Divide.** Rate = earners / players for rare and mid trophies. Near saturation that ratio is ill-conditioned (a
   small miss on players sends a common trophy to 100%), so above a few percent the forecast moves smoothly to the
   decayed logit trend. Earner counts never fall. `enforceStoryOrder` keeps Chapter 1 ≥ … ≥ Chapter 4 ≥ the final
   mission (pool-adjacent-violators on the logits) and the platinum below every trophy, for the median and for every
   quantile column.
6. **Quantiles.** `calibrateQuantiles` takes the residuals of those same in-case pseudo-forecasts, scales them to the
   real horizon (Δu ratio) and splits them by rate band (<1%, 1–10%, 10–60%, ≥60%). The result is mixed with a prior
   logit spread that grows with Δu. It also has a floor, a part-correction for the median bias the cuts show, and a
   little extra width for rare trophies, which dominate a logit-scale loss.
7. **Short history and errors.** With little post-launch history the forecast leans toward persistence: with no
   post-launch refresh at all (the practice cases), toward a diluted persistence with a wide spread. Any internal
   error writes the house persistence baseline for that case (`writeForecast` always gets valid rows).

Node 22 standard library only, no network, deterministic (no randomness), about 10–40 ms per case.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This reads every `*.in` in the input directory in name order and writes `out/<id>.out`:
`{"trophies":[{"id":N,"q":[q05,q25,q50,q75,q95]}, ...]}`. `FORECAST_DEBUG=1` prints the internals to stderr.

## Backtest

```sh
node tools/collect.ts                       # one polite read of the Exophase page -> forecast-data/reads.jsonl
node tools/simulate.ts --seed 1             # a simulated launch week -> forecast-data/sim/s1 (assumptions, not data)
node tools/make-case.ts --suite sim         # final-like (21st 11:30 -> 26th 00:00), early and late cuts per week
node tools/make-case.ts --data <dir> --cut 2026-11-21T11:30:00Z --target 2026-11-26T00:00:00Z --id f00 --out <dir>
node tools/backtest.ts --suites sim,synthetic [--full] [--bands] [--params '{"countsRateCap":30}']
```

`tools/backtest.ts` scores `main.ts` the way the contest scores it (pinball loss on clamped logits, typical miss, 90%
coverage), next to the two house baselines it re-implements from the rules: persistence, and the least-squares line
of logit(rate) against ln(1 + hours) over the last 24 h. `--full` also checks that two runs give the same bytes and
times every case. Collected data lives outside the repository (`FORECAST_DATA`, default: the `forecast-data` folder
beside it).

Exophase answers automated reads with a Cloudflare challenge (HTTP 403), so no post-launch reads of the real page could
be collected. The backtest runs on two suites of simulated weeks instead. `sim` is 25 weeks from `tools/simulate.ts`:
a player-level model of arrival, sync delay, play intensity, drop-off and trophy thresholds, started from the
launch-night page and refreshed on a random cadence with stale pages. `synthetic` is 24 weeks from an earlier,
independent simulator with different assumptions. Each week is cut like the final (`final`: 21st 11:30 → 26th 00:00),
4.5 days a day earlier (`early`), and 2.5 days ahead (`late`). Loss (lower is better), typical miss in points, and 90%
coverage:

| suite / cut | cases | this forecaster | house persistence | house curve |
|---|---|---|---|---|
| sim / final | 25 | **0.274** · 2.20 · 0.98 | 1.189 · 14.70 · 0.44 | 0.743 · 16.98 · 0.79 |
| sim / early | 25 | **0.596** · 5.48 · 0.96 | 2.097 · 17.96 · 0.20 | 1.882 · 20.18 · 0.32 |
| sim / late | 25 | **0.201** · 1.12 · 0.98 | 0.857 · 9.68 · 0.48 | 0.454 · 8.31 · 0.86 |
| synthetic / final | 24 | **0.426** · 2.65 · 0.92 | 1.532 · 11.29 · 0.27 | 0.971 · 16.52 · 0.67 |
| synthetic / early | 24 | **1.428** · 7.46 · 0.62 | 2.538 · 12.86 · 0.12 | 2.089 · 18.27 · 0.27 |
| synthetic / late | 24 | **0.289** · 1.29 · 0.90 | 1.088 · 7.11 · 0.26 | 0.594 · 6.89 · 0.72 |
| all | 147 | **0.532** · 3.36 · 0.89 | 1.547 · 12.30 · 0.30 | 1.120 · 14.54 · 0.61 |

These numbers come from simulators, not from Exophase data. The house AI forecast cannot be backtested.

Built by an AI agent (Claude Code) for the make.fun bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

License: MIT (see `LICENSE`).

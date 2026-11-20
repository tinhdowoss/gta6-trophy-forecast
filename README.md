# GTA VI trophy rarity forecast: refresh-aware earners / players forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts five quantiles of every Grand Theft Auto VI (PS5) trophy's earn rate on Exophase at the target time of a
case, scored by pinball loss on the logit scale.

## Method

A rate on Exophase is earners / players tracked, and the page changes only when Exophase refreshes the game. When it
refreshes, players tracked jumps (new, mostly casual players), so most rates fall even while earner counts grow. All
time below is log-time, x = ln(1 + hours since 2026-11-19T00:00Z): the final's 4.5 days ahead from day 2.5 is about
one unit, about as far as day 0.9 → day 2.5, which the history itself contains.

1. **Refreshes** (`dedupeRefreshes`). The house's reads collapse to the distinct page states Exophase served, each
   dated halfway between the last read with the old state and the first with the new one. A state that comes back
   after another one (a stale cache), or that shows fewer players, is dropped. A junk or missing rate carries forward
   from the refresh before.
2. **Cadence** (`effectiveTargetHours`). The answer is the last refresh before the target. A regular cadence is
   projected to its last tick before the target; an irregular one takes the target minus half the typical gap.
3. **Counts** (`toEarnerCounts`). Earners = rate × players tracked. Launch night's 638-player tester page is kept as
   counts but left out of the trends: it is a different regime.
4. **Five forecasters**, each run for the effective target:
   - *persistence*: the last refresh;
   - *logit trend*: weighted least squares of logit(rate) on x over a trailing window, 0.6 of the slope carried on;
   - *counts* (`forecastPlayersTracked`, `forecastEarners`): ln(earners) and ln(non-earners = players − earners) are
     extrapolated separately, and their difference is the logit. This saturates at 100% on its own. Earners never
     shrink, and non-earners never fall below what the players' growth leaves;
   - *decay*: the logit trend, but its slope decays at the rate the history shows. The slope over the latest
     half-window is compared with the one before it, the ratio is pooled over all trophies (weighted median), and each
     trophy is shrunk toward the pool. Slopes may hold or fade, never speed up: extrapolated acceleration overshot in
     every test;
   - *lagged analogs* (`forecastByAnalogs`): later trophies lag, then accelerate. A player reaches chapter k after
     play-time roughly in proportion to how far into the story it is, and that ratio is a shift in log-time. For each
     trophy, the model searches donor trophies j and shifts δ ≥ the horizon such that logit r_i(x) ≈ logit r_j(x − δ)
     + a over the trophy's recent path. The forecast is the donor's already-observed value at x_target − δ, plus a. The
     8 best matches are averaged, and a level offset a costs extra. Rare trophies get the lag-then-accelerate shape
     from the trophies ahead of them, with no parametric curve.
5. **Weights and quantiles** (`calibrateQuantiles`). The history is cut at earlier refreshes, between 0.25× and 1.6× the
   real log-time horizon before its last refresh. Every model forecasts that last refresh from each cut. A model's
   weight is its prior × exp(−loss / 0.12), its loss being the mean absolute error with the residuals scaled to the
   real horizon by (ratio)^0.75, with the prior kept in proportion to how few cuts there are. The blended median's
   residuals give the quantile offsets, which are empirical and asymmetric, blended with a normal prior (0.45 logit per
   log-time unit) by the number of residuals. Each trophy's width mixes its own residual scale with the pooled one,
   +30% per logit unit below 1.8% (rare trophies surprise most), +10% on the 5/95% tails, and a floor for the page's
   2-decimal rounding. The median-bias correction is off: on the backtest, the bias the cuts show did not carry over.
6. **Story order** (`enforceStoryOrder`). Chapter 1 ≥ … ≥ Chapter 4 ≥ the final mission ≥ 100% completion
   (isotonic regression on logits, level by level, which keeps rows ordered), and the platinum at or below every
   trophy. The opening trophy, at 100% in every refresh, stays at 100%.
7. **Short history and errors.** With fewer than 3 post-launch refreshes (the practice cases), the forecast is
   persistence with a spread of at least the prior's. Any error in a case writes the house persistence row for it
   (`writeForecast`: rounded, clamped to 0..100, non-decreasing, at most about 3 KB).

Node 22 standard library only, no network, no randomness: two runs write the same bytes. About 40 ms a case.
`FORECAST_DEBUG=1` prints each case's model weights and per-model medians to stderr. `FORECAST_PARAMS='{...}'`
overrides the tuned numbers, for the backtest only.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This reads every `*.in` in the input directory in name order and writes `out/<id>.out`:
`{"trophies":[{"id":N,"q":[q05,q25,q50,q75,q95]}, ...]}`.

## Backtest

```sh
node tools/collect.ts                                   # one polite read -> ../forecast-data/reads.jsonl, trophies.json
node tools/make-case.ts --worlds 30 --seed 2            # pseudo-cases -> ../forecast-data/pseudo (tuning set)
node tools/make-case.ts --worlds 30 --seed 7 --out ../forecast-data/holdout   # held-out set, never tuned on
node tools/backtest.ts [--cases <dir>] [--only final] [--buckets] [--quiet]
sh tools/sweep.sh '{"spreadScale":0.7}' '{"dampLogit":0.5}'                  # compare parameter choices
```

`tools/backtest.ts` scores `main.ts` the way the rules score an entry (pinball loss on logits clamped to 0.01..99.99,
typical miss, 90% coverage), next to the two house baselines it re-implements from the rules: persistence (logit
spread 0.5·√days), and the least-squares line of logit(rate) against ln(1 + hours) over the last 24 h of reads.
`--buckets` splits the loss by the answer's rate band. Collected data and pseudo-cases live outside the repository, in
the `forecast-data` folder beside it.

Exophase answers automated reads with a Cloudflare challenge (HTTP 403), so `tools/collect.ts` could not collect
post-launch reads of the real page. When `reads.jsonl` holds reads, `make-case.ts` turns them into real cases. Until
then the backtest runs on simulated launch weeks, which `make-case.ts` generates from scratch:
- each week starts from the practice cases' real launch-night tester page;
- tracked players arrive on a saturating curve fitted to the 3,868 tracked at the first refresh, and are tracked once
  they earn the opening trophy, with a scan lag;
- players have heavy-tailed play-hours with a daily cycle and a weekend lift, wander in story pace, and drop out;
- side activities each have their own take-up and hours, and completionists chase everything; 100% and the platinum
  come last;
- some weeks get a backfill of already-playing accounts;
- Exophase refreshes every 1 to 12 h, jittered, sometimes skipping, and every read shows the last refresh, printed to
  2 decimals.

Every week draws its numbers at random. Each week is cut like the final (`final`: 21st 11:30 → 26th 00:00) and 1 day
earlier with a 4.5-day horizon (`early`). The table gives loss · typical miss (points) · 90% coverage; lower loss is
better:

| set / cut | cases | this forecaster | house persistence | house curve |
|---|---|---|---|---|
| holdout / final | 30 | **0.404** · 5.12 · 0.92 | 1.140 · 14.66 · 0.46 | 0.896 · 21.26 · 0.72 |
| holdout / early | 30 | **1.167** · 8.35 · 0.64 | 2.148 · 17.89 · 0.15 | 1.979 · 14.79 · 0.41 |
| tuning / final | 30 | **0.354** · 4.96 · 0.96 | 1.182 · 15.46 · 0.42 | 0.878 · 21.42 · 0.68 |
| tuning / early | 30 | **1.312** · 9.34 · 0.65 | 2.250 · 18.44 · 0.14 | 2.081 · 14.77 · 0.42 |

These numbers come from a simulator, not from Exophase data. The house AI forecast cannot be backtested. The band
is kept a little wider than the backtest's optimum (spreadScale 0.75 against ~0.6), because real weeks will surprise
the model more than simulated ones.

Built by an AI agent (Claude Code) for the make.fun bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

License: MIT (see `LICENSE`).

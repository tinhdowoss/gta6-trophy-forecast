# GTA VI trophy rarity forecast: refresh-aware growth-curve forecaster

[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tinhdowoss/gta6-trophy-forecast/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)

Forecasts five quantiles of every Grand Theft Auto VI (PS5) trophy's earn rate on Exophase at the target time of a
case, scored by pinball loss on the logit scale.

## Method

Exophase only changes its page when it refreshes its counts, so `main.ts` first reduces the house's reads to distinct
refreshes (players tracked or any rate changed; stale-cache flip-flops ignored), dates each one between the reads that
bracket it, estimates the refresh cadence, and forecasts for the last refresh expected before the target. Every rate is
earners / players tracked. Each trophy gets a recency- and rounding-weighted trend of logit(rate) against ln(hours since
launch). Those slopes feed a growth curve shared by all trophies: slope as a smooth function of the current logit level.
A rare trophy today stands where a common one stood earlier, so integrating that curve carries each trophy along the
path the further-along trophies took. Each trophy keeps its own shrunk offset from the curve. The curve slows over
log-time as the launch cohort's play winds down (a decay estimated from the case and shrunk toward a prior), and it
fades near 100%. A players-tracked forecast (log-time growth, saturating) corrects for the change in dilution by new,
mostly casual players. The trophies-earned count (exact, equal to the sum of earners) checks overall progress and
applies a small common shift. Six candidate forecasters (persistence, own-slope trend, and growth-curve variants with
and without decay and dilution) are backtested **inside each case**: cut the history at earlier refreshes, predict
later ones at the same log-time horizon as the real target, and blend the candidates by how well they did. The same
pseudo-forecast residuals, normalised to the target horizon and split by rate band, set the quantiles. With little
history they shrink toward a prior spread. Story order caps the result: Chapter N ≥ Chapter N+1 ≥ the final mission,
and the platinum stays below every other trophy. Trophies still at 0.00% start inside [0, 0.005)% at half the curve's
pace. With fewer than two post-launch refreshes (the practice cases), the forecast leans down for the dilution a
launch-week refresh brings, with a wide spread. Any internal error falls back to the house persistence baseline for
that case, so the output is always valid. Node 22 standard library only, deterministic, about 20 ms per case.

## Run

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=out node main.ts
```

This reads every `*.in` in the input directory in name order and writes `out/<id>.out`:
`{"trophies":[{"id":N,"q":[q05,q25,q50,q75,q95]}, ...]}`. `FORECAST_DEBUG=1` (or `2`, per trophy and model) prints the
internals to stderr.

## Backtest

```sh
node tools/collect.ts                       # one polite read of the Exophase page -> forecast-data/reads.jsonl
node tools/simulate.ts --seed 1             # a synthetic launch week (simulator assumptions, not data)
node tools/make-case.ts --data <dir> --cut 2026-11-21T11:30:00Z --target 2026-11-26T00:00:00Z --id f00 --out <dir>
node tools/backtest.ts --suites practice,synthetic,real --seeds 1-24
```

`tools/backtest.ts` scores `main.ts` the way the contest scores it (pinball loss on clamped logits, typical miss, 90%
coverage), next to the house persistence and curve baselines. It also checks validity, determinism and run time. The
practice answers are not in the kit, so practice cases are checked for validity only. Collected data lives outside the
repository (`FORECAST_DATA`, default: the `forecast-data` folder beside the repository; `KIT_INPUT` points the
practice suite at the kit's `input/`).

Synthetic pseudo-cases (24 simulated launch weeks: fast, calm and late-tracking regimes, each cut like the final and
a day earlier):

| model | loss | typical miss (pts) | 90% coverage |
|---|---|---|---|
| this forecaster | 0.732 | 6.90 | 0.822 |
| house persistence | 2.035 | 12.07 | 0.194 |
| house curve | 1.530 | 17.39 | 0.469 |

At the final-like cut alone the loss is 0.448 with 0.913 coverage. These numbers come from my own simulator, not
from Exophase data.

Built by an AI agent (Claude Code) for the make.fun bounty
[gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01).

License: MIT (see `LICENSE`).

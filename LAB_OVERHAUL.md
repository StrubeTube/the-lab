# THE LAB — Full Overhaul & ML Retest (2026-08-27)

Commissioned by Alex: "search for other potential statistics… do a full
retest of all the things that go into our lab score, including all the
metrics, including the weights. If we should even have a weight system…
a full machine-learning test of all the metrics… extremely comprehensive."

Run: `python backtest_labscore.py mltest`

## 1. New signals added to the feature library (this round)

From the research pass (breakout-age / dominator literature, EPA models):

| Signal | Source | Notes |
|---|---|---|
| Speed score | combine.csv (cached round 4) | wt·200/40⁴ |
| Burst score | combine.csv vertical + broad jump | explosion proxy |
| Agility score | combine.csv 3-cone + shuttle (inverted) | change-of-direction |
| BMI | combine.csv ht/wt | density (RB archetype) |
| Draft age | birth_date + NFL draft season | proxy for breakout age / early declare (college dominator data has no free source) |
| Passing EPA/gm, CPOE, PACR | nflverse stats_player_reg (2012+) | QB efficiency beyond yards |
| Rushing / receiving EPA/gm | nflverse | scheme-adjusted efficiency |
| WOPR | nflverse | 1.5·target share + 0.7·air-yards share |
| RACR | nflverse | receiver air conversion |
| Weekly boom rate | cached Sleeper weeklies (2013+) | share of prior-season weeks ≥ 15 half-PPR pts |
| Weekly consistency | same | inverted coefficient of variation |

Not obtainable free: college dominator/breakout age (draft age is the proxy),
YPRR (route data is PFF/participation-gated), historical contracts.

## 2. Analyses (all leave-one-season-out unless stated)

1. **Univariate screen** — every feature percentile in the library (~45),
   standalone: LOSO-mean hit-gap (late pool, ADP 84–240) and bust-gap
   (early pool, ADP ≤ 36) + sign stability across folds.
2. **L1 logistic regression** — all features at once, per-position-season
   percentiles, LOSO by season; which features survive regularization,
   with what signs; OOS hit/bust gap when ranking by model probability.
3. **Gradient-boosting oracle** — nonlinear ceiling on the same folds with
   permutation importance. If THIS can't beat the shipped score OOS, no
   combination search will: it bounds what's achievable from this data.
4. **Weight-system question** — shipped hand-tuned pillars vs equal-weight
   vs L1-learned linear vs GBM, all OOS on identical rows. Answers "should
   we even have a weight system" with numbers.
5. **Forward stepwise (combosearch)** — greedy build of an interpretable
   linear score from the full library, each addition judged under the
   grand-audit 5-scheme rule; the only path to SHIPPING a change.
6. Market-free and market-aware variants (with/without the ADP feature) so
   "predicts outcomes" and "beats the market" stay distinct questions.

## 3. Pre-registered decision rule (unchanged from GRAND_AUDIT.md)

A change to the shipped model requires mean Δ > **+1.5** vs baseline across
the five schemes (FWD/REV/ODD/EVEN/LOSO) AND positive in **≥ 4/5**.
ML models (2, 3) are BENCHMARKS — they are never shipped directly; if the
linear ML fit finds a stable, materially better weighting, its weights are
transcribed into a candidate and judged under the same rule.

## 4. Results (executed 2026-08-27)

Pools: 915 late rows (259 hits), 435 early rows (134 busts), 12 seasons.

**Univariate:** usage share metrics rule the ceiling side (tshare +15.1,
WOPR +14.0 at 100% fold stability, yptpa +13.0) — the market itself
(adpinv +14.4) is only par with them. Athleticism is dead on arrival
(speed +0.4, burst −4.8, agility −7.4 — priced into draft capital).
Draft age is the two-sided sleeper: +8.7 bust-side, +4.6 hit-side.
Oddities ruepa +26 / racr +15 on the bust side are coverage artifacts
(≈50% coverage subsets); neither survives blending.

**Weight system (the question):** shipped hand-tuned weights BEAT
equal-weight (LOSO 15.0 vs 7.9 ceiling, 9.3 vs 4.7 safety) and beat the
L1-learned linear model (6.9 ceiling / negative safety) — a linear
learner cannot find better weights than the hand-tuned ones. The GBM
oracle beats shipped ceiling by ~+3 (18.2 vs 15.0) — real but modest
nonlinearity — and LOSES on safety (6.4 vs 9.3). Verdict: keep the
weight system; the pillars are near the information ceiling of the data.

**Forward stepwise (104 candidates/step, 5-scheme rule):** exactly TWO
additions pass, then the search goes dry — and together they close most
of the GBM gap:

- **SAFETY + draft age .15** — mean Δ +3.5, 4/5 schemes; pooled bust gap
  +7.2 → **+13.7**, better-or-equal 10/12 seasons, bootstrap 90% CI
  [−0.9, +12.0]. The breakout-age literature's free proxy, landing on
  the safety side: old-at-draft early picks bust more.
- **CEILING + QB PACR .15** — mean Δ +2.2, 4/5 schemes; pooled hit gap
  +15.1 → +16.0, **never worse in 12/12 seasons**, CI [−0.4, +3.5].
  Only reorders QBs (air-yards conversion); promotes exactly the
  efficient-vet archetype (Goff) the miss autopsy kept flagging.

Post-adoption ceiling LOSO +17.6 ≈ the GBM oracle's +18.2.

**From-scratch greedy rebuild** (informational): picks tshare + aDOT +
CPOE for ceiling (LOSO +17.4) — the same shape as the shipped formula,
independently rediscovered.

**SHIPPED** (compute.py, 2026-08-27): safety = 0.85·safety + 0.15·dage_p;
ceiling = 0.85·ceiling + 0.15·pacr_p (nz 50), applied before the depth
guard. New inputs: m[dage] (age at draft year, inverted), m[pacr]
(nflverse stats_player_reg via fetch_nflverse, 2-yr blend). Everything
else unchanged — every other candidate in the library failed the rule.

Caveat noted: a 104-candidate search inflates false-discovery risk vs
the rule's original single-candidate design; both winners carry
literature priors and 10-12/12 season robustness, which is why they
shipped anyway.

---

# PHASE 2 — Exhausting the options (plan, 2026-08-27)

Executed one by one, a commit per step. Pre-registered rules stated per
step BEFORE running.

- **P0 — Backtest parity.** Port the two shipped winners into
  build_season so the harness baseline IS the shipped model. Every later
  test compares against this.
- **P1 — 2026 prediction freeze.** Snapshot every scored player's
  sc/sfty/ceil/wc/ed/kg/kl + ADP to `data/predictions_2026.json`, plus a
  pre-registered scoring script (`score_predictions.py`) that grades the
  freeze against 2026 finishes in January: hit/bust gaps + Spearman, the
  same metrics as the backtest. The only untainted holdout left.
- **P2 — Irreplaceable-data archiver.** Daily compact snapshots of Vegas
  prop lines (line + both costs) and Sleeper ADP into `data/archive/`,
  written by fetch_data so the GitHub Action commits them. No historical
  archive of props exists at any price; ours starts today.
- **P3 — Continuous-outcome retest.** Re-run the stepwise with a
  rank-correlation objective (score vs points-over-ADP-expectation)
  instead of binary hit/bust gaps. RULE: adopt only if mean Δρ > +0.02
  AND ≥4/5 schemes positive, then re-verify on the binary gaps (must not
  degrade them by >1.0).
- **P4 — Next Gen Stats round.** nflverse NGS (2016+): separation,
  xYAC+/-, RYOE, time-to-throw, aggressiveness, CPAE. Join by gsis,
  2-yr blend, percentile, univariate screen + stepwise on the P0
  baseline under the standard rule.
- **P5 — Interaction terms.** Pairwise products of the top-12 screened
  features + shipped inputs, stepwise under the standard rule. GBM's +3
  bound says expectations modest.
- **P6 — Strength of schedule.** Season SoS from historical schedules
  (games.csv): mean prior-year points allowed of listed opponents, as a
  situation-side candidate under the standard rule.

## Phase 2 results

(filled per step)

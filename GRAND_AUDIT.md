# THE LAB — Grand Audit Plan (2026-08-26)

Re-evaluate EVERYTHING ever considered for the Lab Score against the full
12-season sample (2014–2025), using multiple validation splits so no single
train/holdout partition decides anything. Run via:

    python backtest_labscore.py audit

## 1. Validation schemes (every variant is judged under ALL of these)

| Scheme  | Train side                | Test side                 |
|---------|---------------------------|---------------------------|
| FWD     | 2014–2021                 | 2022–2025                 |
| REV     | 2022–2025                 | 2014–2021 (reversed!)     |
| ODD     | even seasons              | odd seasons               |
| EVEN    | odd seasons               | even seasons              |
| LOSO    | 11 seasons                | the 12th, × 12 folds, averaged |

Fixed on/off rules are evaluated directly on each scheme's test side.
Anything involving *tuning* (weight grids, per-position mixes) is tuned on
the train side and evaluated on the test side of every scheme — testing the
procedure, not a lucky pick.

## 2. Metrics

- **Safety variants** → bust gap among early picks (ADP ≤ 36); bust =
  positional finish worse than 2× positional ADP rank AND worse than 15.
- **Ceiling variants** → hit gap among late picks (ADP 84–240); hit =
  QB/TE top-12, RB/WR top-24.
- **Ramp variants** → league-value sum (early bust gap + ADP 25–240 hit gap).

## 3. Decision rule (PRE-REGISTERED — fixed before results are seen)

A change to the shipped model (adding a rejected rule, removing a shipped
component, adopting different weights) is made ONLY if, versus the shipped
baseline:

- mean Δ across the five schemes > **+1.5 points**, AND
- Δ is positive in **at least 4 of 5** schemes.

Anything short of that keeps the current (simpler/shipped) configuration.
Ties and small margins are treated as unresolvable at this sample size.

## 4. Inventory under test

### Safety (baseline = opp_role .50 / tal .15 / sit .15 / trS .10 / dur .10)
- A1 remove the projected-role blend
- A2 remove talent · A3 remove situation · A4 remove trajectory · A5 remove durability
- A6 durability's weight moved to trajectory (the age-covers-durability theory)
- A7 + TD-dependency .15 (rejected round 1)
- A8 + RB career odometer .15 (rejected round 1)
- A9 moved-team −6 (rejected round 1)
- A10 + injury burden .10 (rejected) · A11 injury burden replacing durability
- T1 weight grid tuned per split (8 candidates) — does tuning generalize?
- P1 per-position safety mixes tuned per split (rejected earlier as overfit)

### Ceiling (baseline = .25/.30/.20/.25 base + rz .10 + WR aDOT .08 + window +4 + pedigree 90/10)
- D1 re-add talent-over-usage gap (removed by ablation)
- D2 remove red-zone role · D3 remove WR aDOT · D4 remove window · D5 remove pedigree
- D6 + target-share growth .12 (rejected round 2)
- D7 + December role growth .12 (rejected round 2)
- D8 + usage-vs-output gap .12 (rejected round 2)
- D9 + WR unrealized air yards .10 (rejected round 2)
- D10 the round-2 combo
- T2 base-weight grid tuned per split (8 candidates)
- P2 per-position ceiling mixes tuned per split

### wc ramp (baseline = (adp−24)/96 clamped .15–.85)
- R1 .5@42 · R2 .5@54 · R3 steep .5@48 · R4 later .5@96 · R5 flat 0.5

## 5. Output

One table per family: variant × five scheme-Δs vs baseline + mean Δ +
verdict (SHIP / KEEP OUT / KEEP IN / KEEP CURRENT) applied strictly by the
rule in §3. Every verdict is final for this audit; the section stays in the
backtest so future seasons re-run it.

---

## RESULTS (executed 2026-08-26)

**Passed the rule (adopted, sequentially with re-tests):**
- **A6 — durability's weight moved to trajectory** (safety = .50/.15/.15/.20,
  dur 0): mean Δ +2.5, positive 4/5 schemes. Alex's original
  "the age curve covers durability" theory, rejected on the 8-season single
  split, WINS on the full sample. Adopted.
- **T2 — ceiling base reweighted to .35 opp / .25 tal / .15 sit / .25 trC**:
  tuning picked this set in 12/12 LOSO folds (mean Δ +2.4, 5/5). Adopted as
  a fixed set.
- D10 (round-2 combo) passed on the OLD base (+1.6, 5/5) but FAILED the
  re-test on the new T2 base (−0.5) — its signal was absorbed by the higher
  opportunity weight. Kept out.

**Everything else failed the rule** — all round-1/round-2 candidates, the
injury variants, per-position mixes (both families), every ramp variant, and
every removal of a shipped component. After adoption, a re-run shows every
family fully converged: no variant improves the new baselines.

**Final validated state (12 seasons):** ceiling hit gap 36%/21%
(bootstrap 90% CI [+10.1, +19.7], positive 10/12 seasons); safety bust gap
27%/34% (CI [+0.3, +14.6] — real but modest and noisy; note the pooled
point dipped 8.1→7.2 on adoption while multi-scheme robustness improved,
which is the trade the pre-registered rule makes on purpose).

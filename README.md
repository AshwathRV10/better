# better

A sports prediction analytics platform. It produces **calibrated probability
estimates** for football, tennis and basketball fixtures, compares them against
bookmaker prices with the margin removed, and reports its own measured
out-of-sample accuracy so you can judge whether the probabilities are worth
anything.

It is deliberately not a tipping service. Every prediction ships with the
model's probability, the market's implied probability, the difference between
them, an estimated expected value, a confidence score, a data-quality score, and
the model version that produced it.

> Predictions are probabilistic estimates, not guarantees. Sports outcomes are
> uncertain, and historical model performance does not guarantee future results.

---

## Contents

- [What it does](#what-it-does)
- [Measured performance](#measured-performance)
- [Architecture](#architecture)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Running locally](#running-locally)
- [Running the tests](#running-the-tests)
- [Prediction methodology](#prediction-methodology)
- [Backtesting methodology](#backtesting-methodology)
- [Adding a data provider](#adding-a-data-provider)
- [Adding a sport](#adding-a-sport)
- [API](#api)
- [Deployment](#deployment)
- [Limitations](#limitations)

---

## What it does

| Page | What it answers |
|---|---|
| **Dashboard** | What is on today, what does the model think, and where does it disagree with the market? |
| **Match analysis** | Why does the model think that? Which sub-models agree? What is the full market set? What data is missing? |
| **Value** | Which selections carry positive expected value — and is the claimed edge larger than the model has ever demonstrated it can find? |
| **Performance** | Is the model actually any good? Accuracy, log loss, Brier score, skill over the base rate, calibration curve, walk-forward backtests. |
| **Tracker** | Did the claimed edge materialise? A ledger of recorded predictions with P/L and ROI. |
| **Admin** | Pipeline health, model registry, ingestion history, measured accuracy. |

Markets covered:

- **Football** — match winner (1X2), over/under goals, both teams to score, correct score, Asian handicap
- **Tennis** — match winner, set winner, total games, games handicap
- **Basketball** — moneyline, point spread, total points

---

## Measured performance

These are real numbers from the walk-forward backtest against the bundled demo
data, not aspirations. **Skill** is the fractional improvement in log loss over
predicting the observed base rate; **market** is the bookmaker's own margin-free
log loss over the same fixtures, which is the practical ceiling for a model with
no private information.

| Sport | Predictions | Accuracy | Log loss | Base rate | Skill | Market | Calibration error |
|---|---|---|---|---|---|---|---|
| Tennis | 216 | 78.7% | 0.4500 | 0.6928 | **+35.1%** | 0.4246 | 2.7pp |
| Basketball | 230 | 59.1% | 0.6688 | 0.6764 | **+1.1%** | 0.6303 | 2.9pp |
| Football | 300 | 47.7% | 1.0525 | 1.0560 | **+0.3%** | 1.0450 | 3.1pp |

All three beat the base rate out of sample and land close to the market ceiling.
The demo world's own theoretical maximum skill — computed by scoring the
simulator's true generating probabilities against its own results — is 41.8% for
tennis, 5.0% for basketball and 2.4–3.8% for football, so the model captures
roughly 82%, 38% and 28% of the available signal respectively.

Football's ceiling is genuinely low here: the demo simulator produces a league
whose 1X2 outcomes are less predictable than real football, where bookmaker odds
typically achieve 7–8% skill over the base rate. That is a property of the demo
data, not a claim about the model on real fixtures.

The confidence score is doing real work: on settled predictions, HIGH-confidence
calls outscore MEDIUM ones (basketball 64.8% vs 52.4% accuracy, tennis 80.0% vs
76.1%).

---

## Architecture

```
Browser
  │
  ├── Next.js App Router (server components)  ─┐
  └── REST API (/api/*)                        │  same read models,
                                               │  same numbers
  ┌────────────────────────────────────────────┘
  ▼
Services  ── predictions · analysis · training · performance · bets · ingestion
  │
  ├── Prediction engine (src/lib/prediction)   framework-free, no database
  ├── Value engine      (src/lib/odds)         pure functions
  └── Backtester        (src/lib/backtest)
  │
  ▼
Prisma  ──▶  PostgreSQL
  ▲
  │
Data provider adapter  ──  demo (simulated) │ api-football (live)
```

Two boundaries matter:

1. **The prediction engine never touches the database.** It takes a
   `MatchContext` in and returns a `MatchPrediction` out. That is what makes it
   testable without fixtures and portable to a worker or a separate service.
2. **The UI never talks to an external API.** Providers are adapters behind one
   interface, so swapping data sources is one environment variable.

### Why TypeScript rather than a Python service

The statistical work here — Dixon-Coles bivariate Poisson, Elo with
margin-of-victory, a point→game→set→match hierarchy, softmax regression with
cross-validated regularisation, temperature-scaled calibration — is a few
hundred lines of well-tested numerical code. Implementing it in TypeScript keeps
one language, one test runner, one build and one deployment, and lets the exact
same functions run in the API, the backtester and the unit tests. The engine is
isolated behind a plain data interface, so moving it to a Python service later
is a port of one module rather than a rewrite.

### Layout

```
src/
  app/                      routes: pages + /api handlers
  components/               UI: cards, tables, charts, filters
  lib/
    prediction/             the engine
      math/                 poisson · tennis hierarchy · calibration · stats
      features/             form · strength · venue · h2h · rest · availability
      models/               elo · softmax regression
      sports/               football · tennis · basketball · registry
      ensemble.ts           weighted blending + stacked weight fitting
      confidence.ts         eight-component confidence score
      dataQuality.ts        six-component data-quality score
      explain.ts            explanations generated from real feature values
      engine.ts             orchestration
    odds/                   implied probability · margin removal · EV · Kelly
    backtest/               walk-forward harness + metrics
    providers/              adapter interface · demo simulator · api-football
    services/               DB-facing orchestration and read models
    api/                    validation, auth, rate limiting, error envelope
prisma/                     schema, migrations, seed
scripts/                    train · backtest · reset-db
tests/                      unit · integration · e2e
```

---

## Setup

Requirements: **Node 20+**, **PostgreSQL 14+**.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL
npm run db:migrate            # create the schema
npm run db:seed               # ingest, train, predict, score  (~45s)
npm run dev                   # http://localhost:3000
```

The seed runs the whole pipeline: it ingests the configured provider, trains
each sport's models out of sample, backfills predictions for finished matches at
their own kickoff times, scores measured performance, and finally predicts the
upcoming fixtures.

Optionally, run the walk-forward backtest and store the results so they appear
on the performance page:

```bash
npm run backtest -- --save
```

---

## Environment variables

Copy `.env.example` to `.env`. Nothing is hard-coded and no secret is ever sent
to the browser.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `NEXT_PUBLIC_APP_URL` | no | Public base URL |
| `DATA_PROVIDER` | no | `demo` (default) or `api-football` |
| `SPORTS_API_KEY` | for live data | api-football.com key |
| `SPORTS_API_BASE_URL` | no | Override the provider host |
| `ODDS_API_KEY` | no | the-odds-api.com key |
| `API_ACCESS_KEY` | **in production** | Shared secret required by mutating API routes. Unset means writes are open, which is fine locally and not acceptable in a deployment. |
| `RATE_LIMIT_MAX` | no | Requests per window per client (default 120) |
| `RATE_LIMIT_WINDOW_MS` | no | Window length in ms (default 60000) |

If `DATA_PROVIDER` names a live provider but its key is missing, the app falls
back to demo data and says so on the admin page rather than starting up empty.

---

## Database

PostgreSQL via Prisma. Sixteen tables covering reference data (sports, leagues,
teams, players), fixtures (matches, events, team/player statistics, availability),
market data (odds), the model registry (model versions, predictions, prediction
outcomes, prediction features, model component outcomes, team ratings),
evaluation (model performance, backtests) and the tracker (users, bets), plus
ingestion runs.

```bash
npm run db:migrate      # develop: create/apply a migration
npm run db:deploy       # production: apply pending migrations
npm run db:seed         # run the full pipeline
npm run db:clear        # truncate every table, keep the schema
```

Indexes cover the access patterns that matter: fixtures by league and kickoff,
by status and kickoff, by team; odds by match and market; prediction outcomes by
market and expected value.

---

## Running locally

```bash
npm run dev             # development server
npm run build           # production build
npm run start           # serve the production build
npm run models:train    # retrain, rescore, re-predict
npm run backtest        # walk-forward validation (add --save to store)
```

---

## Running the tests

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run test            # vitest: unit + integration  (271 tests)
npm run test:ui         # build, then Playwright across desktop and mobile
npm run verify          # typecheck + lint + test
```

Integration tests **truncate every table**, so they are pinned to their own
database through `.env.test`. Create it once:

```bash
createdb betterdb_test
DATABASE_URL="postgresql://.../betterdb_test" npx prisma migrate deploy
```

What the suites cover:

- **Unit (197)** — Poisson and Dixon-Coles, the tennis hierarchy, Elo updates
  and rating replay, implied probability, margin removal (multiplicative,
  additive, Shin), EV, Kelly, feature engineering, calibration fitting, softmax
  regression, and the full engine on synthetic contexts. Includes the
  specification's worked examples: odds 2.00 → 50%, and p=0.60 at 2.00 → +20% EV.
- **Integration (74)** — ingestion idempotency, look-ahead protection, training,
  prediction persistence, market consistency, read models, performance scoring,
  bet settlement rules, provider adapters and a walk-forward backtest, all
  against a real PostgreSQL database.
- **End-to-end (59)** — navigation, filtering, the match analysis, value
  reliability, performance charts, the tracker, admin, responsive behaviour, the
  theme toggle, accessibility basics, and assertions that the demo-data banner
  and the responsible-use disclaimer are present and that no guarantee language
  appears anywhere.

---

## Prediction methodology

### The pipeline

```
MatchContext ─▶ Feature engineering ─▶ Sub-models ─▶ Ensemble
             ─▶ Calibration ─▶ Confidence · Data quality · Explanation
```

### Sub-models

**Football — Dixon-Coles bivariate Poisson.** Expected goals for each side come
from the league's home/away baselines multiplied by both teams' attack and
defence strengths, then adjusted for availability, fatigue and head-to-head. The
joint score distribution carries the Dixon-Coles low-score correction
(ρ = −0.04), which lifts 0-0 and 1-1 and suppresses 1-0 and 0-1 as real football
scorelines do. **Every football market is derived from that one distribution**,
so the 1X2 prices and the correct-score prices can never contradict each other.

**Tennis — point → game → set → match.** Each player's service-point win
probability is estimated from the rating gap, form and rest, then propagated
analytically: game win probability in closed form, tiebreaks by exact dynamic
programming, sets by enumerating legal scorelines with the correct serve order,
and the match by convolving set outcomes while carrying the serve across set
boundaries. The distribution is averaged over who serves first, since the toss is
unknown at prediction time and measurably shifts the game margin. The Elo→serve
mapping is anchored to the published behaviour of tennis Elo (a 100-point gap ≈
a 64% favourite) and the anchor is asserted in the test suite.

**Basketball — normal margin and total.** Scores are the sum of ~100 possessions
per side, so the margin and total are close to normal. Offensive and defensive
ratings combine **additively** — multiplying them compounds the two effects and
a plausible ±7% rating spread then implies 30-point expected margins, roughly
triple reality.

**Elo** — dynamic ratings with a margin-of-victory multiplier (logarithmic, with
the autocorrelation correction so a strong team's blowout counts slightly less)
and a home-advantage term suppressed at neutral venues. Ratings are replayed from
each league's full finished history at the prediction instant, never cached, so a
backtested prediction sees only the ratings that existed at the time.

**Weighted form** — an interpretable weighted sum of recency-decayed signals. The
coefficients are fixed and documented rather than fitted, which is what makes it
a genuinely independent view rather than a second ML model.

**ML baseline** — multinomial logistic regression trained by L2-regularised
gradient descent, with **the penalty selected by held-out validation**. A fixed
penalty does not work across sports and sample sizes: with a few hundred matches
and ten features, too little regularisation memorises the training block and
scores worse than the base rate out of sample. If no penalty beats the base rate,
the model returns nothing rather than handing noise to the ensemble.

**Market component** — the bookmaker's margin-free probabilities are computed and
displayed for comparison at **weight zero**. They are never blended into the
model probability; doing so would make every reported edge circular.

### Ensemble

Weights are fitted by stacked generalisation: each component is scored on a
held-out block it did not contribute to fitting, and weights are set proportional
to each component's skill over the base rate. Components with no demonstrated
skill get no weight. Because skill measured on a few dozen matches is itself
noisy, the fitted weights are shrunk toward the sport's defaults in proportion to
the size of the held-out block — the same empirical-Bayes shrinkage used for team
strength.

The split matters. An earlier version scored components on a slice the ML model
had been trained on; the ML component looked excellent in-sample, took nearly all
the weight, and drove football's skill to **−4.2%**. Fixing the split and adding
cross-validated regularisation moved it to **+0.8%**.

### Calibration

Raw ensemble output is usually over-confident. A temperature-scaling correction
with per-class bias (k+1 parameters for k classes, few enough to fit on a few
hundred matches) is fitted on held-out predictions by minimising log loss — a
proper scoring rule, so it drives probabilities toward true frequencies rather
than toward whatever maximises hit rate.

### Confidence — deliberately not the probability

A 90% favourite predicted from three matches of history with no team news
deserves *low* confidence. The score combines eight signals: data quality, sample
size, model agreement, prediction separation, team-news certainty, market
corroboration, the model version's historical Brier score and its measured
calibration error.

Model agreement is shrunk toward neutral by the sample size. With no history
every component falls back to the same league prior and "agrees" perfectly, and
reading that as confidence is exactly the failure mode this score exists to
avoid.

### Data quality and missing data

Every prediction carries a 0–100 data-quality score built from six observable
components, and an explicit list of what is missing. **Missing data lowers
confidence rather than being invented.** A fixture with no completed matches on
either side gets no prediction at all — the API returns 422 and the dashboard
says "insufficient history", because a prediction with nothing behind it is a
league-average prior wearing a costume.

### Value, and honesty about it

For decimal odds:

```
implied probability = 1 / odds
EV                  = (model probability × odds) − 1
edge                = model probability − margin-free implied probability
```

The overround is removed before computing the edge (Shin's method by default,
which takes proportionally more margin from longshots), so an edge is never
inflated by the bookmaker's margin.

Every opportunity also carries a **reliability** classification. A large
disagreement with a well-priced market is far more often a model error than a
market error, so an edge beyond three times the model's *measured* calibration
error is flagged **"beyond model accuracy"** rather than presented as an
opportunity. The arithmetic is still shown — it is correct — but it assumes the
model probability is right, and the model's own record says how far that
assumption stretches. Without this the top of the value board was a +118% EV
selection generated purely by model error.

Staking references use **quarter-Kelly capped at 2% of bankroll**. Full Kelly
maximises long-run log growth only when probabilities are *known*; when they are
estimated it is far too aggressive.

---

## Backtesting methodology

```
for each test window:
    train on everything strictly before the window
    predict every match inside the window
    record and advance
```

Three leaks are prevented by construction:

1. Ratings, form and league baselines are rebuilt at each match's own kickoff.
2. The ML model, ensemble weights and calibrator are refitted per window from
   earlier matches only, with the ML fit and the weight fit on **disjoint**
   blocks.
3. Odds are filtered to quotes captured before kickoff, so a closing price can
   never inform a pre-match prediction.

Reported metrics: accuracy, log loss, Brier score, skill over the base rate,
calibration bins and expected calibration error, per-component standalone skill,
ROI at flat stakes on positive-EV selections, and the market's own margin-free
log loss as a ceiling.

**ROI is a diagnostic, never a target.** A model optimised for backtest ROI fits
the noise in one odds history; one optimised for log loss and calibration
generalises.

---

## Adding a data provider

Implement `SportsDataProvider` (`src/lib/providers/types.ts`) and register it:

```ts
export class MyProvider implements SportsDataProvider {
  readonly name = 'my-provider';
  readonly origin = 'LIVE';           // or 'DEMO'
  isConfigured() { return Boolean(process.env.MY_API_KEY); }
  async fetchLeagues() { /* ... */ }
  async fetchTeams(leagueKey) { /* ... */ }
  async fetchPlayers(teamKey) { /* ... */ }
  async fetchMatches(options) { /* ... */ }
  async fetchOdds(matchExternalIds) { /* ... */ }
  async fetchAvailability(matchExternalIds) { /* ... */ }
}
```

Add it to `createProvider()` in `src/lib/providers/registry.ts` and set
`DATA_PROVIDER`. Return normalised records; the ingestion service handles
upserting and idempotency. `origin` propagates to the UI, so anything not `LIVE`
is labelled as demo data everywhere it appears.

`ApiFootballProvider` is a complete worked example with timeouts, rate-limit
handling and typed error translation.

## Adding a sport

Implement `SportModule` (`src/lib/prediction/types.ts`) — feature builder,
sub-models, declared markets, class labels, a result classifier — and register it
in `src/lib/prediction/sports/registry.ts`. Nothing else changes: the engine, the
API, the value engine, the backtester and the UI all work from the module's
declared markets and classes.

---

## API

All responses use `{ data, meta }`; errors use
`{ error: { code, message, details? } }`. Every route validates its input with
Zod and is rate limited per client.

| Method | Route | Notes |
|---|---|---|
| GET | `/api/sports` | |
| GET | `/api/leagues` | `?sport=` |
| GET | `/api/matches` | `?sport= &league= &date= &from= &to= &status= &limit= &offset=` |
| GET | `/api/matches/:id` | |
| GET | `/api/matches/:id/prediction` | Full analysis; generates on demand |
| GET | `/api/matches/:id/odds` | Grouped by selection, best price marked |
| GET | `/api/predictions` | `?sport= &league= &date= &confidence=` |
| POST | `/api/predictions` | Generate/regenerate. **Requires `x-api-key`** |
| GET | `/api/value-opportunities` | `?minEv= &minEdge= &minProbability= &confidence= &market=` |
| GET | `/api/model-performance` | `?sport= &league= &confidence=` |
| GET | `/api/backtests` | `?sport= &limit=` |
| GET | `/api/bets` | Ledger plus portfolio summary |
| POST | `/api/bets` | Record. **Requires `x-api-key`** |
| PATCH | `/api/bets/:id` | Settle manually. **Requires `x-api-key`** |
| GET | `/api/health` | Liveness, counts, freshness, ingestion history |

Status codes: 400 validation, 401 missing/invalid key, 404 not found, 422
insufficient data to predict, 429 rate limited, 502/503 provider errors.

### Security

Secrets come from the environment only and are never returned by any route —
`/api/health` and the admin page report *whether* a key is configured, never its
value. Mutating routes require a shared secret compared in constant time. All
input is validated with Zod. Prisma parameterises every query. Security headers
are set globally. Internal errors never leak their message to the client.

---

## Deployment

1. Provision PostgreSQL and set `DATABASE_URL`.
2. Set `API_ACCESS_KEY` to a strong secret (`openssl rand -hex 32`).
3. `npm ci && npm run db:deploy && npm run build && npm run start`.
4. Seed or ingest: `npm run db:seed`, or point `DATA_PROVIDER` at a live source.
5. Schedule `npm run models:train` (which re-ingests nothing but retrains,
   rescores and re-predicts) and a periodic ingestion.
6. Monitor `/api/health`.

Runs anywhere Node and PostgreSQL run — a container, a VM, or a Node-runtime
serverless platform.

---

## Limitations

These are real, not boilerplate.

- **The bundled data is simulated.** Teams, players, fixtures, results and prices
  are generated by a seeded simulator and are labelled `DEMO DATA` throughout.
  They are not real sport. Live data requires a provider key.
- **Football skill is low on the demo data.** ~0.3–0.8% over the base rate,
  against a demo-world ceiling of 2.4–3.8%. Real football markets show 7–8%
  skill, so this number says more about the simulator than about the model.
- **The ML component has negative standalone skill in football and basketball**
  (−10.4% and −7.5% out of sample). The stacked weighting demotes it, and the
  ensemble still beats every individual component in football, but the feature
  set clearly does not carry enough signal for those two sports yet.
- **Only the match-winner market is calibrated and scored.** Derived markets
  inherit the goal model's internal consistency but have no calibration fit or
  measured accuracy of their own.
- **Tennis and basketball settlement is partial.** Set winner, total games and
  games handicap cannot be settled from the final score columns alone, so those
  bets stay pending for manual settlement rather than being guessed at.
- **Rate limiting is in-process.** It is per-instance and resets on restart; a
  multi-instance deployment needs a shared store such as Redis.
- **There is no authentication for users.** The tracker uses a single local
  account. Adding real auth means adding a session layer; the schema already has
  a `users` table with per-user bets.
- **`api-football` covers football only,** and the free tier's rate limits make
  a full historical backfill slow. The odds adapter reads match-winner markets
  only.
- **Injury impact is modelled from a share of squad value,** which the demo
  simulator provides directly. Real feeds rarely expose per-player importance, so
  the live adapter spreads it evenly and the model's availability signal is
  correspondingly weaker.

---

## Responsible use

This is an analytics tool. It is built to show you how uncertain a prediction is,
where the data is thin, and when its own claimed edge is too large to believe. It
does not promise profit, and a model that is well calibrated is still wrong a
great deal of the time — that is what a probability means.

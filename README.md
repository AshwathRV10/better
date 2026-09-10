# better

A football match predictor built on **real data**. It imports completed results
and upcoming fixtures for five European leagues, fits Elo ratings, recent form
and a Dixon-Coles scoring model on them, and publishes calibrated 1X2
probabilities for the fixtures in the next seven days.

Every team, fixture and result the app shows in its default configuration is a
real one. There is a simulator, but it is opt-in and for development only: the
live provider **never** falls back to it. If the data source is unreachable the
interface shows an error rather than substituting invented fixtures.

It is deliberately not a tipping service. Every prediction ships with the
model's probability, its fair odds, a confidence score, a data-quality score,
the reasons derived from the features the model actually used, and the model
version that produced it. Where bookmaker prices are available it also shows the
market's implied probability and the estimated edge; where they are not, the
prediction stands on its own and the market columns are dropped rather than
filled with dashes.

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

The two views that matter:

| Page | What it answers |
|---|---|
| **Dashboard** | Which real fixtures are in the next seven days, and what does the model think of each? |
| **Match analysis** | Why does it think that? Expected goals, both sides' recent form and record by venue, Elo, head-to-head, which sub-models agree, and the reasons drawn from the feature values actually used. |

Three further pages are retained from the general-purpose build and still work,
but are secondary to the football predictor:

| Page | What it answers |
|---|---|
| **Performance** | Is the model any good? Accuracy, log loss, Brier score, skill over the base rate, calibration curve, walk-forward backtests. |
| **Value** | Which selections carry positive expected value? Requires an odds feed; with the default provider this board is empty and says so. |
| **Tracker** / **Admin** | A ledger of recorded bets; pipeline health, model registry and ingestion history. |

### Leagues

Five leagues are imported by default, chosen because the source covers them
completely and consistently:

| League | Country | Source code |
|---|---|---|
| Premier League | England | `en.1` |
| La Liga | Spain | `es.1` |
| Serie A | Italy | `it.1` |
| Bundesliga | Germany | `de.1` |
| Ligue 1 | France | `fr.1` |

### Markets

All derived from one joint score distribution, so they are mutually consistent:
match winner (1X2), over/under goals, both teams to score, correct score, Asian
handicap.

The tennis and basketball engines from the earlier general-purpose build remain
in the codebase and are unit-tested, but no live data source is configured for
them, so they are dormant.

### Data source

Football data comes from
[**openfootball/football.json**](https://github.com/openfootball/football.json),
a public-domain dataset ("use as you please with no restrictions whatsoever")
served from `raw.githubusercontent.com`. It supplies fixtures, kick-off times
and full-time scores. It does **not** supply bookmaker odds, expected goals, or
team news, and the app says so rather than inventing them — the data-quality
score is lowered accordingly and no prediction is presented as more informed
than it is.

Responses are cached on disk under `.cache/openfootball` with a six-hour TTL, so
a re-run of the pipeline does not re-fetch what it already has.

#### On FotMob

FotMob was investigated as a richer source and **rejected**. It publishes no
public API, and its site and internal endpoints are unreachable from this
environment — including `robots.txt`, which means its terms for automated access
cannot even be read, let alone complied with. Scraping it would be exactly the
thing to avoid, so the app does not touch it and does not depend on it.

---

## Measured performance

These are real numbers from a walk-forward backtest on the imported real
results, not aspirations, and not the simulator. 2,906 matches across the five
leagues were predicted out of sample in 20 chronological windows, each model
refitted on matches strictly before the window it predicts.

```
npm run backtest -- --sport football --initial 600 --step 150
```

| Model | n | Accuracy | Log loss | Brier |
|---|---|---|---|---|
| Base rate (prior) | 2,906 | 44.7% | 1.0604 | 0.6417 |
| Elo only | 2,906 | 53.1% | 1.0016 | 0.5928 |
| Recent form only | 2,906 | 51.7% | 1.0264 | 0.6069 |
| Poisson / Dixon-Coles only | 2,906 | 53.2% | 0.9881 | 0.5885 |
| **Combined (calibrated)** | **2,906** | **54.2%** | **0.9861** | **0.5863** |

Reference points: a uniform 1/3-each forecast scores 1.0986 log loss and 0.6667
Brier. Calibration error over the whole sample is **1.35 percentage points**.

How to read this:

- **Every layer earns its place.** Each sub-model beats the base-rate prior, and
  the blend beats every one of its parts on both proper scoring rules. The
  ensemble weights fitted in the final window were Poisson 0.46, Elo 0.32, form
  0.22 — the model is not leaning on a single component.
- **The gain over the prior is 6.9% of log loss.** That is a real but modest
  edge, and it is the right order of magnitude for football 1X2: the outcome is
  genuinely close to unpredictable, and published bookmaker odds typically
  achieve 7–8% skill over the base rate. A model claiming much more than this on
  1X2 is almost certainly leaking future information.
- **54.2% accuracy is not 54.2% profit.** Accuracy on a three-way market with a
  ~44% modal class is a weak summary; the log loss and Brier columns are what
  the model is actually optimised for. No claim is made — and none should be
  inferred — that this model is profitable against a bookmaker's prices. It has
  never been tested against real closing odds, because the data source carries
  none.
- **The earlier figures in this README's history were measured on the
  simulator** and are not evidence about real football. They have been removed.

A learned multinomial-logistic component was also tried and **removed**:
measured out of sample on this data it scored worse than the base rate, so
football now runs on the three interpretable models only (`usesMl: false` on the
football sport module).

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
Data provider adapter
  ├── openfootball  (LIVE, default)  real fixtures + results, no key needed
  ├── api-football  (LIVE)           requires SPORTS_API_KEY
  └── demo          (DEMO, opt-in)   simulator, development only
```

Three boundaries matter:

1. **The prediction engine never touches the database.** It takes a
   `MatchContext` in and returns a `MatchPrediction` out. That is what makes it
   testable without fixtures and portable to a worker or a separate service.
2. **The UI never talks to an external API.** Providers are adapters behind one
   interface, so swapping data sources is one environment variable.
3. **A live provider never silently becomes the demo one.** `resolveProvider()`
   throws if `DATA_PROVIDER` names an unconfigured or unknown provider, and the
   page renders that error. Demo data is reached only by setting
   `DATA_PROVIDER=demo` explicitly, and everything it produces is labelled as
   simulated in the header, in a page-wide banner and on each match.

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
    providers/              adapter interface · openfootball · api-football · demo simulator
    services/               DB-facing orchestration and read models
    api/                    validation, auth, rate limiting, error envelope
prisma/                     schema, migrations, seed
scripts/                    data (bootstrap/sync) · train · backtest · reset-db
tests/                      unit · integration · e2e
```

---

## Setup

Requirements: **Node 20+**, **PostgreSQL 14+**.

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL
npm run db:migrate            # create the schema
npm run data:bootstrap        # import real football data end to end  (~3 min)
npm run dev                   # http://localhost:3000
```

`data:bootstrap` clears any existing sport data and rebuilds from scratch:

1. **Ingest** — downloads the configured seasons for the five leagues, creating
   real teams, completed results and upcoming fixtures. Fails loudly if it
   imports zero completed matches rather than leaving an empty app.
2. **Train** — fits ensemble weights and the calibrator out of sample and
   registers a new model version.
3. **Backfill** — predicts historical matches *at their own kick-off times*, so
   the measured accuracy on the performance page is honest.
4. **Score** — computes measured performance per model version.
5. **Predict** — publishes probabilities for every fixture in the next week.

Afterwards, keep it current with:

```bash
npm run data:sync             # incremental: new results + new fixtures
```

`data:sync` does the same work without clearing, and is safe to run on a cron.
Both respect the on-disk response cache, so repeated runs within the TTL do not
re-download anything.

Optionally, run the walk-forward backtest and store the results so they appear
on the performance page:

```bash
npm run backtest -- --sport football --initial 600 --step 150 --save
```

### Development with the simulator

The simulator is still available for tests and offline development. It is
**never** reached by accident:

```bash
DATA_PROVIDER=demo npm run db:seed
```

Everything it produces is stamped `origin: 'DEMO'` in the database and rendered
with a warning banner, a header badge and a per-match label.

---

## Environment variables

Copy `.env.example` to `.env`. Nothing is hard-coded and no secret is ever sent
to the browser.

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `NEXT_PUBLIC_APP_URL` | no | Public base URL |
| `DATA_PROVIDER` | no | `openfootball` (default), `api-football`, or `demo` |
| `OPENFOOTBALL_SEASONS` | no | Comma-separated seasons to import, e.g. `2024-25,2025-26,2026-27` |
| `SPORTS_API_KEY` | only for `api-football` | api-football.com key. The default provider needs no key. |
| `SPORTS_API_BASE_URL` | no | Override the provider host |
| `ODDS_API_KEY` | no | the-odds-api.com key |
| `API_ACCESS_KEY` | **in production** | Shared secret required by mutating API routes. Unset means writes are open, which is fine locally and not acceptable in a deployment. |
| `RATE_LIMIT_MAX` | no | Requests per window per client (default 120) |
| `RATE_LIMIT_WINDOW_MS` | no | Window length in ms (default 60000) |

Two knobs control how much is fetched, both read by `scripts/data.ts`:
`HISTORY_DAYS` (default 900, roughly two seasons) and `FORECAST_DAYS` (default
8). Nothing beyond those windows is downloaded.

If `DATA_PROVIDER` names a live provider whose configuration is missing, or a
provider that does not exist, `resolveProvider()` **throws**. It does not fall
back to demo data. The pipeline stops with the reason, and the interface renders
an error. Showing simulated fixtures as if they were real would be worse than an
outage.

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
npm run data:bootstrap  # clear sport data and rebuild from the live source
npm run data:sync       # incremental refresh
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
npm run data:sync       # refresh results and fixtures
npm run models:train    # retrain, rescore, re-predict
npm run backtest        # walk-forward validation (add --save to store)
```

---

## Running the tests

```bash
npm run typecheck       # tsc --noEmit
npm run lint            # eslint
npm run test            # vitest: unit + integration  (277 tests)
npm run test:ui         # build, then Playwright across desktop and mobile
npm run verify          # typecheck + lint + test
```

> Run `npm run test:ui` on its own. Two `next build` processes writing `.next`
> concurrently leave a manifest referencing chunks the other build replaced;
> every page then fails with a client-side exception, which looks like an
> application bug and is not one. Kill any running build or `next start` and
> delete `.next` before rebuilding if you hit it.

Integration tests **truncate every table**, so they are pinned to their own
database through `.env.test`. Create it once:

```bash
createdb betterdb_test
DATABASE_URL="postgresql://.../betterdb_test" npx prisma migrate deploy
```

What the suites cover:

- **Unit (203)** — Poisson and Dixon-Coles, the tennis hierarchy, Elo updates
  and rating replay, implied probability, margin removal (multiplicative,
  additive, Shin), EV, Kelly, feature engineering, calibration fitting, softmax
  regression, and the full engine on synthetic contexts. Includes the
  specification's worked examples: odds 2.00 → 50%, and p=0.60 at 2.00 → +20% EV.
  Also covers promoted-team Elo seeding, which real data exposed and the
  simulator could not.
- **Integration (74)** — ingestion idempotency, look-ahead protection, training,
  prediction persistence, market consistency, read models, performance scoring,
  bet settlement rules, provider adapters and a walk-forward backtest, all
  against a real PostgreSQL database. Provider tests assert that LIVE mode never
  degrades to demo: an unconfigured or unknown `DATA_PROVIDER` raises.
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

The Poisson component carries the largest ensemble weight on real data (0.46),
and standalone it is the strongest single model (log loss 0.9881 against a
1.0604 base rate).

**Tennis — point → game → set → match.** *(Engine present and tested; no live
data source configured.)* Each player's service-point win
probability is estimated from the rating gap, form and rest, then propagated
analytically: game win probability in closed form, tiebreaks by exact dynamic
programming, sets by enumerating legal scorelines with the correct serve order,
and the match by convolving set outcomes while carrying the serve across set
boundaries. The distribution is averaged over who serves first, since the toss is
unknown at prediction time and measurably shifts the game margin. The Elo→serve
mapping is anchored to the published behaviour of tennis Elo (a 100-point gap ≈
a 64% favourite) and the anchor is asserted in the test suite.

**Basketball — normal margin and total.** *(Engine present and tested; no live
data source configured.)* Scores are the sum of ~100 possessions
per side, so the margin and total are close to normal. Offensive and defensive
ratings combine **additively** — multiplying them compounds the two effects and
a plausible ±7% rating spread then implies 30-point expected margins, roughly
triple reality.

**Elo** — dynamic ratings with a margin-of-victory multiplier (logarithmic, with
the autocorrelation correction so a strong team's blowout counts slightly less)
and a home-advantage term suppressed at neutral venues. Ratings are replayed from
each league's full finished history at the prediction instant, never cached, so a
backtested prediction sees only the ratings that existed at the time.

A club appearing for the first time is seeded at the mean of the division's
**weakest third**, not at the league average. This matters on real data and could
not be seen on the simulator, which has no promotion: seeded at the average,
newly promoted sides came out rated above mid-table on two matches — Hull City at
1519 against Southampton's 1318. With the weakest-third seed they land where they
belong (Hull 1383, Coventry 1349, Southampton 1306).

**Weighted form** — an interpretable weighted sum of recency-decayed signals. The
coefficients are fixed and documented rather than fitted, which is what makes it
a genuinely independent view rather than a second ML model.

**ML baseline — off for football.** Multinomial logistic regression trained by
L2-regularised gradient descent, with the penalty selected by held-out
validation. Measured out of sample on real football results it scored worse than
the base rate, so the football module sets `usesMl: false` and the component is
not built at all. It remains available to the other two sports. Keeping a model
that does not pay for itself would be complexity for its own sake, and the
backtest is what decided it.

**Market component** — where an odds feed exists, the bookmaker's margin-free
probabilities are computed and displayed for comparison at **weight zero**. With
the default provider there is no odds feed, so this component is absent and the
interface drops the market columns rather than showing empty ones. They are never blended into the
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

> **With the default provider there are no odds, so none of this is active.** It
> is documented because the code is there and works the moment an odds source is
> configured. Nothing on the dashboard or the match page shows an edge or an EV
> without a real price behind it.

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

4. The base-rate prior it is compared against is counted over the training block
   only, not over the whole sample. A prior that knows the final home-win rate is
   a stronger opponent than the one you could actually have used at the time, and
   comparing against it would understate the model.

Reported metrics: accuracy, log loss, Brier score, skill over the base rate,
calibration bins and expected calibration error, and a side-by-side comparison of
the prior, each component standalone and the calibrated ensemble. Where odds
exist it also reports ROI at flat stakes on positive-EV selections and the
market's own margin-free log loss as a ceiling; with the default provider both
are absent, and the run reports `0 bets` rather than a fabricated return.

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

Add it to `createProvider()` and `isProviderKey()` in
`src/lib/providers/registry.ts`, then set `DATA_PROVIDER`. Return normalised
records; the ingestion service handles upserting and idempotency. `origin`
propagates to the UI, so anything not `LIVE` is labelled as demo data everywhere
it appears.

Two rules for a live provider:

- **`isConfigured()` must be honest.** If it returns `false`, `resolveProvider()`
  throws and the app shows an error. It does not fall back.
- **Return nothing rather than something invented.** `OpenFootballProvider`
  returns `[]` from `fetchPlayers`, `fetchOdds` and `fetchAvailability` because
  its source has no such data. Fabricating plausible values there would poison
  the data-quality score, the confidence score and every explanation built on
  them.

`OpenFootballProvider` is the smallest complete example (no key, disk cache,
honest empty methods). `ApiFootballProvider` is the fuller one, with timeouts,
rate-limit handling and typed error translation.

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
4. Load the data once: `npm run data:bootstrap`.
5. Schedule `npm run data:sync` daily. It re-ingests new results and fixtures,
   retrains, rescores and re-predicts in one pass, and is idempotent.
6. Monitor `/api/health`. `providerConfigured: false` or an ingestion run with
   `status: "FAILED"` means the app is serving stale data — it will not have
   invented anything to fill the gap, so the fixture list simply stops growing.

Runs anywhere Node and PostgreSQL run — a container, a VM, or a Node-runtime
serverless platform.

---

## Limitations

These are real, not boilerplate.

- **There are no odds.** The public-domain dataset carries fixtures and results
  only. That means no implied probability, no edge, no expected value, no
  Kelly stake, and — most importantly — **no evidence whatsoever that this model
  would be profitable against a bookmaker**. It has beaten the base rate; it has
  never been tested against a real price. The value board and the tracker exist
  and work, but need an odds feed to do anything.
- **No expected-goals or shot data.** The engine can blend xG-based attack and
  defence strengths when a source supplies them, and does so for other providers,
  but this one does not. Team strength comes from goals alone.
- **No team news.** Injuries and suspensions are not factored in. The interface
  says "Not known" rather than "None reported" so an absent feed is not mistaken
  for a clean bill of health, and the data-quality score is reduced accordingly.
- **Mean data quality is around 51/100**, and no upcoming prediction reaches HIGH
  confidence — most are MEDIUM, some LOW. That is the correct output for a model
  running on results alone, and the app reports it rather than flattering itself.
- **The measured edge over the base rate is 6.9% of log loss.** Real, repeatable
  across 2,906 out-of-sample matches, and modest. Football 1X2 is close to
  unpredictable and this does not change that.
- **Only the match-winner market is calibrated and scored.** Derived markets
  inherit the goal model's internal consistency but have no calibration fit or
  measured accuracy of their own.
- **Fixture coverage depends on the upstream dataset.** Seasons are published as
  they are played; a match with no recorded result whose kick-off has passed is
  treated as `POSTPONED` and excluded from both the fixture list and the training
  set, rather than being shown as an upcoming fixture.
- **Tennis and basketball are dormant.** The engines are implemented and unit
  tested, but no live source is configured for them, so they have no data.
- **Rate limiting is in-process.** It is per-instance and resets on restart; a
  multi-instance deployment needs a shared store such as Redis.
- **There is no authentication for users.** The tracker uses a single local
  account. Adding real auth means adding a session layer; the schema already has
  a `users` table with per-user bets.
- **FotMob is not used.** See [On FotMob](#on-fotmob). No public API, terms not
  readable from this environment, therefore not scraped.

---

## Responsible use

This is an analytics tool. It is built to show you how uncertain a prediction is,
where the data is thin, and when its own claimed edge is too large to believe. It
does not promise profit, and a model that is well calibrated is still wrong a
great deal of the time — that is what a probability means.

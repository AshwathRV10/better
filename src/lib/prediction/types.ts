/**
 * Core domain types for the prediction engine.
 *
 * Everything in `src/lib/prediction` is framework- and database-free: it takes
 * plain data in and returns plain data out. The persistence layer is
 * responsible for loading a `MatchContext` and storing a `MatchPrediction`.
 */

export type SportKey = 'football' | 'tennis' | 'basketball';

export type MarketKey =
  | 'MATCH_WINNER'
  | 'OVER_UNDER'
  | 'BTTS'
  | 'CORRECT_SCORE'
  | 'ASIAN_HANDICAP'
  | 'POINT_SPREAD'
  | 'SET_WINNER'
  | 'TOTAL_GAMES'
  | 'HANDICAP_GAMES';

export type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type FeatureCategory =
  | 'RATING'
  | 'FORM'
  | 'ATTACK'
  | 'DEFENCE'
  | 'HOME_AWAY'
  | 'H2H'
  | 'REST'
  | 'AVAILABILITY'
  | 'CONTEXT';

/** A single completed match as seen by the engine. */
export interface HistoricalMatch {
  readonly id: string;
  readonly leagueKey: string;
  readonly kickoff: Date;
  readonly homeTeamId: string;
  readonly awayTeamId: string;
  readonly homeScore: number;
  readonly awayScore: number;
  readonly neutralVenue: boolean;
  readonly homeXg?: number;
  readonly awayXg?: number;
  readonly homeShots?: number;
  readonly awayShots?: number;
  readonly homeShotsOnTarget?: number;
  readonly awayShotsOnTarget?: number;
  /** Tennis: sets won by each side. Basketball: period scores. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface TeamRatingSnapshot {
  readonly teamId: string;
  readonly elo: number;
  readonly attack: number;
  readonly defence: number;
  readonly matchesPlayed: number;
}

export interface AbsentPlayer {
  readonly playerId: string;
  readonly name: string;
  readonly position?: string;
  /** 0..1 share of the team's on-pitch value. */
  readonly importance: number;
  readonly status: string;
}

export interface OddsQuote {
  readonly bookmaker: string;
  readonly market: MarketKey;
  readonly selection: string;
  readonly line?: number;
  /** Decimal odds, strictly greater than 1. */
  readonly price: number;
  readonly capturedAt: Date;
}

export interface TeamContext {
  readonly teamId: string;
  readonly name: string;
  readonly shortName: string;
  /** Most recent first is NOT assumed; the engine sorts by kickoff. */
  readonly recentMatches: readonly HistoricalMatch[];
  readonly rating: TeamRatingSnapshot;
  readonly absentees: readonly AbsentPlayer[];
  /** Total squad importance mass, used to normalise the availability feature. */
  readonly squadImportanceTotal: number;
}

/** League-wide baselines, needed to express strength relative to the league. */
export interface LeagueBaseline {
  readonly leagueKey: string;
  readonly name: string;
  readonly strength: number;
  readonly averageHomeScore: number;
  readonly averageAwayScore: number;
  readonly homeWinRate: number;
  readonly drawRate: number;
  readonly awayWinRate: number;
  readonly matchesObserved: number;
}

/** Everything the engine needs to predict one fixture. */
export interface MatchContext {
  readonly matchId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly kickoff: Date;
  readonly neutralVenue: boolean;
  readonly home: TeamContext;
  readonly away: TeamContext;
  readonly headToHead: readonly HistoricalMatch[];
  readonly league: LeagueBaseline;
  readonly odds: readonly OddsQuote[];
  /** Timestamp of the newest data point in this context. */
  readonly dataTimestamp: Date;
  /** Evaluation time. Nothing after this instant may enter the context. */
  readonly asOf: Date;
}

export interface Feature {
  readonly name: string;
  readonly value: number;
  readonly category: FeatureCategory;
  /** Signed contribution toward the home side. */
  readonly contribution?: number;
  /** Rendered description used by the explainability panel. */
  readonly label: string;
  /** True when the underlying data was missing and a neutral default was used. */
  readonly imputed: boolean;
}

export interface FeatureVector {
  readonly features: readonly Feature[];
  readonly byName: Readonly<Record<string, number>>;
  /** Share of features backed by real observations (0..1). */
  readonly completeness: number;
  readonly version: string;
}

/** One priced selection inside a market. */
export interface OutcomeProbability {
  readonly market: MarketKey;
  readonly selection: string;
  readonly line?: number;
  readonly probability: number;
}

/** Output of one sub-model, kept separate so the UI can show model agreement. */
export interface ComponentPrediction {
  readonly component: string;
  readonly weight: number;
  readonly outcomes: readonly OutcomeProbability[];
}

export interface ExplanationItem {
  readonly kind: 'SUPPORT' | 'RISK';
  readonly text: string;
  readonly featureName: string;
  readonly magnitude: number;
}

export interface DataQualityReport {
  readonly score: number; // 0..100
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly weight: number;
    readonly detail: string;
  }>;
  readonly missing: readonly string[];
}

export interface ConfidenceReport {
  readonly level: ConfidenceLevel;
  readonly score: number; // 0..100
  readonly components: ReadonlyArray<{
    readonly name: string;
    readonly score: number;
    readonly weight: number;
    readonly detail: string;
  }>;
}

export interface MatchPrediction {
  readonly matchId: string;
  readonly sportKey: SportKey;
  readonly modelVersion: string;
  readonly featuresVersion: string;
  readonly predictedAt: Date;
  readonly dataTimestamp: Date;
  readonly expectedHomeScore?: number;
  readonly expectedAwayScore?: number;
  readonly outcomes: readonly OutcomeProbability[];
  readonly components: readonly ComponentPrediction[];
  readonly features: readonly Feature[];
  readonly explanation: readonly ExplanationItem[];
  readonly dataQuality: DataQualityReport;
  readonly confidence: ConfidenceReport;
}

/** Weights of a trained multinomial logistic regression. */
export interface MlWeights {
  readonly featureNames: readonly string[];
  /** [class][feature] plus a bias term per class at index `featureNames.length`. */
  readonly coefficients: readonly (readonly number[])[];
  readonly classes: readonly string[];
  readonly trainedOn: number;
  readonly trainedThrough: string | null;
}

/** Calibration parameters applied to ensemble output before publication. */
export interface CalibrationParams {
  /** Temperature > 0. Values above 1 soften probabilities toward uniform. */
  readonly temperature: number;
  /** Per-class log-odds shifts. */
  readonly classBias: readonly number[];
  readonly classes: readonly string[];
  readonly fittedOn: number;
}

export interface EnsembleWeights {
  readonly [component: string]: number;
}

/** Everything a sport module needs to be reproducible. */
export interface ModelParameters {
  readonly ensembleWeights: EnsembleWeights;
  readonly calibration: CalibrationParams | null;
  readonly ml: MlWeights | null;
  readonly elo: EloConfig;
  readonly form: FormConfig;
}

export interface EloConfig {
  readonly initialRating: number;
  readonly kFactor: number;
  readonly homeAdvantage: number;
  readonly marginMultiplier: number;
  /** Divisor in the logistic expectation; 400 is the chess convention. */
  readonly scale: number;
}

export interface FormConfig {
  readonly lookback: number;
  /** Per-match exponential decay, applied to the match's age in the window. */
  readonly halfLifeMatches: number;
}

/** A sport plug-in. Adding a sport means adding one of these. */
export interface SportModule {
  readonly key: SportKey;
  readonly markets: readonly MarketKey[];
  readonly featuresVersion: string;
  readonly defaultParameters: ModelParameters;
  buildFeatures(ctx: MatchContext, params: ModelParameters): FeatureVector;
  predict(
    ctx: MatchContext,
    features: FeatureVector,
    params: ModelParameters,
  ): {
    readonly components: readonly ComponentPrediction[];
    readonly expectedHomeScore?: number;
    readonly expectedAwayScore?: number;
  };
  /** Class labels used by the ML model and calibrator, e.g. ['HOME','DRAW','AWAY']. */
  readonly classes: readonly string[];
  /**
   * Whether this sport's ensemble includes the learned ML component.
   *
   * Football sets this to false: measured out of sample it scored ~10% WORSE
   * than the base rate, so the ensemble is the three interpretable models
   * instead. Keeping the flag on the module means the training pipeline skips
   * fitting a model that would never be used.
   */
  readonly usesMl: boolean;
  /** Maps a finished match to its class label, for training and evaluation. */
  resultClass(match: Pick<HistoricalMatch, 'homeScore' | 'awayScore'>): string;
}

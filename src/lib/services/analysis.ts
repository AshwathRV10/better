/**
 * Match analysis read model.
 *
 * Assembles everything the match-analysis page shows: the stored prediction,
 * every market, the per-model agreement panel, the feature breakdown grouped by
 * category, the explanation, both sides' recent form and the head-to-head
 * record. Where no prediction exists yet, one is generated on demand.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generatePrediction, matchInclude } from './predictions';
import { buildMatchContext } from './context';
import { computeForm, computeHeadToHead, computeRest, venueRecord, type VenueRecord } from '../prediction/features';
import { getSportModule } from '../prediction/sports/registry';
import { getActiveModelVersion, loadModelParameters } from './modelVersions';
import type { ConfidenceLevel, SportKey } from '../prediction/types';
import type { OutcomeDto } from './queries';

export interface ComponentAgreementDto {
  readonly component: string;
  readonly weight: number;
  readonly outcomes: ReadonlyArray<{ selection: string; probability: number }>;
}

export interface FeatureDto {
  readonly name: string;
  readonly value: number;
  readonly contribution: number | null;
  readonly category: string;
  readonly label: string;
}

export interface TeamFormDto {
  readonly teamKey: string;
  readonly name: string;
  readonly shortName: string;
  /** Newest first, e.g. ['W','W','D','L','W']. */
  readonly results: readonly string[];
  readonly weightedPoints: number;
  readonly goalsForPerMatch: number;
  readonly goalsAgainstPerMatch: number;
  readonly matchesPlayed: number;
  readonly elo: number;
  readonly daysSinceLastMatch: number | null;
  readonly matchesInLast14Days: number;
  /** Won/drawn/lost split by venue over the same history the model used. */
  readonly homeRecord: VenueRecord;
  readonly awayRecord: VenueRecord;
  /**
   * Whether a team-news feed covered this side at all. Without one an empty
   * absentee list means "not known", not "everyone is fit", and the interface
   * has to say which.
   */
  readonly availabilityReported: boolean;
  readonly absentees: ReadonlyArray<{ name: string; position: string | null; status: string; importance: number }>;
}

export interface HeadToHeadDto {
  readonly meetings: number;
  readonly homeWins: number;
  readonly draws: number;
  readonly awayWins: number;
  readonly averageTotalGoals: number;
  readonly recent: ReadonlyArray<{
    date: string;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
  }>;
}

export interface MatchAnalysisDto {
  readonly matchId: string;
  readonly sportKey: string;
  readonly leagueName: string;
  readonly leagueKey: string;
  readonly kickoff: string;
  readonly venue: string | null;
  readonly neutralVenue: boolean;
  readonly status: string;
  readonly origin: string;
  readonly homeTeam: { key: string; name: string; shortName: string };
  readonly awayTeam: { key: string; name: string; shortName: string };
  readonly homeScore: number | null;
  readonly awayScore: number | null;

  readonly modelVersion: string;
  readonly featuresVersion: string;
  readonly predictedAt: string;
  readonly dataTimestamp: string;
  readonly expectedHomeScore: number | null;
  readonly expectedAwayScore: number | null;
  readonly confidence: ConfidenceLevel;
  readonly confidenceScore: number;
  readonly confidenceComponents: ReadonlyArray<{ name: string; score: number; weight: number; detail: string }>;
  readonly dataQuality: number;
  readonly dataQualityComponents: ReadonlyArray<{ name: string; score: number; weight: number; detail: string }>;
  readonly missingData: readonly string[];
  readonly explanation: ReadonlyArray<{ kind: string; text: string; featureName: string; magnitude: number }>;

  readonly outcomes: readonly OutcomeDto[];
  readonly components: readonly ComponentAgreementDto[];
  readonly features: readonly FeatureDto[];
  readonly homeForm: TeamFormDto;
  readonly awayForm: TeamFormDto;
  readonly headToHead: HeadToHeadDto;
}

interface StoredExplanation {
  items?: Array<{ kind: string; text: string; featureName: string; magnitude: number }>;
  confidence?: Array<{ name: string; score: number; weight: number; detail: string }>;
  dataQuality?: Array<{ name: string; score: number; weight: number; detail: string }>;
  missing?: string[];
}

/** The prediction service's include, plus the team rows the page renders. */
const analysisInclude = {
  ...matchInclude,
  homeTeam: { select: { key: true, name: true, shortName: true } },
  awayTeam: { select: { key: true, name: true, shortName: true } },
} satisfies Prisma.MatchInclude;

export async function getMatchAnalysis(matchId: string): Promise<MatchAnalysisDto | null> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, include: analysisInclude });
  if (!match) return null;

  let prediction = await prisma.prediction.findFirst({
    where: { matchId },
    include: {
      outcomes: true,
      features: true,
      components: true,
      modelVersion: { select: { version: true } },
    },
    orderBy: { predictedAt: 'desc' },
  });

  // Generate on demand so a newly ingested fixture is never a dead end.
  if (!prediction) {
    await generatePrediction(match);
    prediction = await prisma.prediction.findFirst({
      where: { matchId },
      include: {
        outcomes: true,
        features: true,
        components: true,
        modelVersion: { select: { version: true } },
      },
      orderBy: { predictedAt: 'desc' },
    });
  }
  if (!prediction) return null;

  const sportKey = match.sport.key as SportKey;
  const sportModule = getSportModule(sportKey);
  const modelVersion = await getActiveModelVersion(sportKey);
  const parameters = loadModelParameters(modelVersion, sportKey);

  // Rebuilt at the prediction's own instant so the panels agree with it.
  const ctx = await buildMatchContext(match, { asOf: prediction.predictedAt });
  const featureVector = sportModule.buildFeatures(ctx, parameters);
  const labelByName = new Map(featureVector.features.map((feature) => [feature.name, feature.label]));

  const homeForm = computeForm(ctx.home, prediction.predictedAt, parameters.form);
  const awayForm = computeForm(ctx.away, prediction.predictedAt, parameters.form);
  const homeRest = computeRest(ctx.home, prediction.predictedAt);
  const awayRest = computeRest(ctx.away, prediction.predictedAt);
  const h2h = computeHeadToHead(ctx.headToHead, ctx.home.teamId, ctx.away.teamId, prediction.predictedAt);

  const teamNames = new Map<string, string>([
    [match.homeTeamId, match.homeTeam.shortName],
    [match.awayTeamId, match.awayTeam.shortName],
  ]);

  const stored = (prediction.explanation ?? {}) as StoredExplanation;

  const componentMap = new Map<string, ComponentAgreementDto>();
  for (const row of prediction.components) {
    const entry = componentMap.get(row.component) ?? {
      component: row.component,
      weight: row.weight,
      outcomes: [],
    };
    componentMap.set(row.component, {
      ...entry,
      outcomes: [...entry.outcomes, { selection: row.selection, probability: row.probability }],
    });
  }

  return {
    matchId: match.id,
    sportKey,
    leagueName: match.league.name,
    leagueKey: match.league.key,
    kickoff: match.kickoff.toISOString(),
    venue: match.venue,
    neutralVenue: match.neutralVenue,
    status: match.status,
    origin: match.origin,
    homeTeam: { key: match.homeTeam.key, name: match.homeTeam.name, shortName: match.homeTeam.shortName },
    awayTeam: { key: match.awayTeam.key, name: match.awayTeam.name, shortName: match.awayTeam.shortName },
    homeScore: match.homeScore,
    awayScore: match.awayScore,

    modelVersion: prediction.modelVersion.version,
    featuresVersion: prediction.featuresVersion,
    predictedAt: prediction.predictedAt.toISOString(),
    dataTimestamp: prediction.dataTimestamp.toISOString(),
    expectedHomeScore: prediction.expectedHomeScore,
    expectedAwayScore: prediction.expectedAwayScore,
    confidence: prediction.confidence as ConfidenceLevel,
    confidenceScore: prediction.confidenceScore,
    confidenceComponents: stored.confidence ?? [],
    dataQuality: prediction.dataQuality,
    dataQualityComponents: stored.dataQuality ?? [],
    missingData: stored.missing ?? [],
    explanation: stored.items ?? [],

    outcomes: prediction.outcomes.map((outcome) => ({
      market: outcome.market,
      selection: outcome.selection,
      line: outcome.line,
      probability: outcome.probability,
      fairOdds: outcome.fairOdds,
      bookmaker: outcome.bookmaker,
      bookmakerOdds: outcome.bookmakerOdds,
      impliedProbability: outcome.impliedProbability,
      edge: outcome.edge,
      expectedValue: outcome.expectedValue,
      kellyStake: outcome.kellyStake,
    })),
    components: [...componentMap.values()],
    features: prediction.features.map((feature) => ({
      name: feature.name,
      value: feature.value,
      contribution: feature.contribution,
      category: feature.category,
      label: labelByName.get(feature.name) ?? feature.name,
    })),
    homeForm: {
      teamKey: match.homeTeam.key,
      name: match.homeTeam.name,
      shortName: match.homeTeam.shortName,
      results: homeForm.results,
      weightedPoints: homeForm.weightedPoints,
      goalsForPerMatch: homeForm.goalsForPerMatch,
      goalsAgainstPerMatch: homeForm.goalsAgainstPerMatch,
      matchesPlayed: homeForm.sampleSize,
      elo: ctx.home.rating.elo,
      daysSinceLastMatch: homeRest.daysSinceLastMatch,
      matchesInLast14Days: homeRest.matchesInLast14Days,
      homeRecord: venueRecord(ctx.home, prediction.predictedAt, 'home'),
      awayRecord: venueRecord(ctx.home, prediction.predictedAt, 'away'),
      availabilityReported: ctx.home.squadImportanceTotal > 0,
      absentees: ctx.home.absentees.map((player) => ({
        name: player.name,
        position: player.position ?? null,
        status: player.status,
        importance: player.importance,
      })),
    },
    awayForm: {
      teamKey: match.awayTeam.key,
      name: match.awayTeam.name,
      shortName: match.awayTeam.shortName,
      results: awayForm.results,
      weightedPoints: awayForm.weightedPoints,
      goalsForPerMatch: awayForm.goalsForPerMatch,
      goalsAgainstPerMatch: awayForm.goalsAgainstPerMatch,
      matchesPlayed: awayForm.sampleSize,
      elo: ctx.away.rating.elo,
      daysSinceLastMatch: awayRest.daysSinceLastMatch,
      matchesInLast14Days: awayRest.matchesInLast14Days,
      homeRecord: venueRecord(ctx.away, prediction.predictedAt, 'home'),
      awayRecord: venueRecord(ctx.away, prediction.predictedAt, 'away'),
      availabilityReported: ctx.away.squadImportanceTotal > 0,
      absentees: ctx.away.absentees.map((player) => ({
        name: player.name,
        position: player.position ?? null,
        status: player.status,
        importance: player.importance,
      })),
    },
    headToHead: {
      meetings: h2h.meetings,
      homeWins: h2h.homeWins,
      draws: h2h.draws,
      awayWins: h2h.awayWins,
      averageTotalGoals: h2h.averageTotalGoals,
      recent: ctx.headToHead.slice(0, 6).map((meeting) => ({
        date: meeting.kickoff.toISOString(),
        homeTeam: teamNames.get(meeting.homeTeamId) ?? 'Unknown',
        awayTeam: teamNames.get(meeting.awayTeamId) ?? 'Unknown',
        homeScore: meeting.homeScore,
        awayScore: meeting.awayScore,
      })),
    },
  };
}

export interface MatchOddsDto {
  readonly market: string;
  readonly selection: string;
  readonly line: number | null;
  readonly bookmakers: ReadonlyArray<{ bookmaker: string; price: number; capturedAt: string }>;
  readonly bestPrice: number;
  readonly bestBookmaker: string;
}

/** Current market for a match, grouped by selection with the best price marked. */
export async function getMatchOdds(matchId: string): Promise<MatchOddsDto[]> {
  const rows = await prisma.odds.findMany({
    where: { matchId },
    orderBy: { capturedAt: 'desc' },
  });

  const grouped = new Map<string, MatchOddsDto>();
  const seen = new Set<string>();

  for (const row of rows) {
    // Rows arrive newest-first, so the first sighting of a bookmaker/selection
    // pair is its latest price.
    const dedupeKey = `${row.market}|${row.selection}|${row.line ?? ''}|${row.bookmaker}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const key = `${row.market}|${row.selection}|${row.line ?? ''}`;
    const entry = grouped.get(key) ?? {
      market: row.market,
      selection: row.selection,
      line: row.line,
      bookmakers: [],
      bestPrice: 0,
      bestBookmaker: '',
    };
    const bookmakers = [
      ...entry.bookmakers,
      { bookmaker: row.bookmaker, price: row.price, capturedAt: row.capturedAt.toISOString() },
    ];
    const best = bookmakers.reduce((a, b) => (b.price > a.price ? b : a));
    grouped.set(key, { ...entry, bookmakers, bestPrice: best.price, bestBookmaker: best.bookmaker });
  }

  return [...grouped.values()];
}

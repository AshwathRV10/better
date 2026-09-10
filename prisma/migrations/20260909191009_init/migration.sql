-- CreateEnum
CREATE TYPE "DataOrigin" AS ENUM ('DEMO', 'LIVE');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Market" AS ENUM ('MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'CORRECT_SCORE', 'ASIAN_HANDICAP', 'POINT_SPREAD', 'SET_WINNER', 'TOTAL_GAMES', 'HANDICAP_GAMES');

-- CreateEnum
CREATE TYPE "ConfidenceLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "BetResult" AS ENUM ('PENDING', 'WON', 'LOST', 'PUSH', 'VOID');

-- CreateEnum
CREATE TYPE "StakingMethod" AS ENUM ('FLAT', 'PERCENT_BANKROLL', 'FRACTIONAL_KELLY');

-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bankroll" DECIMAL(12,2) NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sports" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leagues" (
    "id" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "strength" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "externalId" TEXT,
    "origin" "DataOrigin" NOT NULL DEFAULT 'DEMO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "leagueId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "country" TEXT,
    "externalId" TEXT,
    "origin" "DataOrigin" NOT NULL DEFAULT 'DEMO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "sportId" TEXT NOT NULL,
    "leagueId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "round" INTEGER,
    "homeTeamId" TEXT NOT NULL,
    "awayTeamId" TEXT NOT NULL,
    "kickoff" TIMESTAMP(3) NOT NULL,
    "venue" TEXT,
    "neutralVenue" BOOLEAN NOT NULL DEFAULT false,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "scoreDetail" JSONB,
    "externalId" TEXT,
    "origin" "DataOrigin" NOT NULL DEFAULT 'DEMO',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_events" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "minute" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "teamId" TEXT,
    "playerId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_statistics" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "goalsFor" INTEGER,
    "goalsAgainst" INTEGER,
    "xg" DOUBLE PRECISION,
    "xga" DOUBLE PRECISION,
    "shots" INTEGER,
    "shotsOnTarget" INTEGER,
    "possession" DOUBLE PRECISION,
    "corners" INTEGER,
    "extra" JSONB,

    CONSTRAINT "team_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_statistics" (
    "id" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "minutes" INTEGER,
    "goals" INTEGER,
    "assists" INTEGER,
    "rating" DOUBLE PRECISION,
    "extra" JSONB,

    CONSTRAINT "player_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "player_availability" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "playerId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "player_availability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "selection" TEXT NOT NULL,
    "line" DOUBLE PRECISION,
    "price" DOUBLE PRECISION NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isClosing" BOOLEAN NOT NULL DEFAULT false,
    "origin" "DataOrigin" NOT NULL DEFAULT 'DEMO',

    CONSTRAINT "odds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parameters" JSONB NOT NULL,
    "trainedAt" TIMESTAMP(3),
    "trainedThrough" TIMESTAMP(3),
    "trainingSampleSize" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "predictions" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "featuresVersion" TEXT NOT NULL,
    "predictedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataTimestamp" TIMESTAMP(3) NOT NULL,
    "expectedHomeScore" DOUBLE PRECISION,
    "expectedAwayScore" DOUBLE PRECISION,
    "confidence" "ConfidenceLevel" NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "dataQuality" INTEGER NOT NULL,
    "explanation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_outcomes" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "selection" TEXT NOT NULL,
    "line" DOUBLE PRECISION,
    "probability" DOUBLE PRECISION NOT NULL,
    "fairOdds" DOUBLE PRECISION NOT NULL,
    "bookmaker" TEXT,
    "bookmakerOdds" DOUBLE PRECISION,
    "impliedProbability" DOUBLE PRECISION,
    "edge" DOUBLE PRECISION,
    "expectedValue" DOUBLE PRECISION,
    "kellyStake" DOUBLE PRECISION,

    CONSTRAINT "prediction_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_features" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "contribution" DOUBLE PRECISION,
    "category" TEXT NOT NULL,

    CONSTRAINT "prediction_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_component_outcomes" (
    "id" TEXT NOT NULL,
    "predictionId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "market" "Market" NOT NULL,
    "selection" TEXT NOT NULL,
    "probability" DOUBLE PRECISION NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "model_component_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_ratings" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "elo" DOUBLE PRECISION NOT NULL,
    "attack" DOUBLE PRECISION NOT NULL,
    "defence" DOUBLE PRECISION NOT NULL,
    "matchesPlayed" INTEGER NOT NULL DEFAULT 0,
    "modelVersionId" TEXT,

    CONSTRAINT "team_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_performance" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "leagueKey" TEXT,
    "confidence" "ConfidenceLevel",
    "market" "Market" NOT NULL,
    "predictions" INTEGER NOT NULL,
    "correct" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "logLoss" DOUBLE PRECISION NOT NULL,
    "brierScore" DOUBLE PRECISION NOT NULL,
    "roi" DOUBLE PRECISION,
    "winRate" DOUBLE PRECISION,
    "averageOdds" DOUBLE PRECISION,
    "averageEdge" DOUBLE PRECISION,
    "calibration" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_performance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtests" (
    "id" TEXT NOT NULL,
    "modelVersionId" TEXT NOT NULL,
    "sportKey" TEXT NOT NULL,
    "leagueKey" TEXT,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "matches" INTEGER NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "logLoss" DOUBLE PRECISION NOT NULL,
    "brierScore" DOUBLE PRECISION NOT NULL,
    "roi" DOUBLE PRECISION NOT NULL,
    "betsPlaced" INTEGER NOT NULL,
    "staked" DOUBLE PRECISION NOT NULL,
    "profit" DOUBLE PRECISION NOT NULL,
    "calibration" JSONB NOT NULL,
    "equityCurve" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bets" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "predictionId" TEXT,
    "market" "Market" NOT NULL,
    "selection" TEXT NOT NULL,
    "line" DOUBLE PRECISION,
    "odds" DOUBLE PRECISION NOT NULL,
    "stake" DECIMAL(12,2) NOT NULL,
    "stakingMethod" "StakingMethod" NOT NULL DEFAULT 'FLAT',
    "modelProbability" DOUBLE PRECISION NOT NULL,
    "impliedProbability" DOUBLE PRECISION NOT NULL,
    "edge" DOUBLE PRECISION NOT NULL,
    "expectedValue" DOUBLE PRECISION NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "result" "BetResult" NOT NULL DEFAULT 'PENDING',
    "profitLoss" DECIMAL(12,2),
    "settledAt" TIMESTAMP(3),
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "bets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_runs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "sportKey" TEXT,
    "status" "IngestionStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "matchesUpserted" INTEGER NOT NULL DEFAULT 0,
    "oddsUpserted" INTEGER NOT NULL DEFAULT 0,
    "predictionsWritten" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sports_key_key" ON "sports"("key");

-- CreateIndex
CREATE INDEX "leagues_sportId_idx" ON "leagues"("sportId");

-- CreateIndex
CREATE UNIQUE INDEX "leagues_sportId_key_key" ON "leagues"("sportId", "key");

-- CreateIndex
CREATE INDEX "teams_leagueId_idx" ON "teams"("leagueId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_sportId_key_key" ON "teams"("sportId", "key");

-- CreateIndex
CREATE INDEX "players_teamId_idx" ON "players"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "players_teamId_key_key" ON "players"("teamId", "key");

-- CreateIndex
CREATE INDEX "matches_leagueId_kickoff_idx" ON "matches"("leagueId", "kickoff");

-- CreateIndex
CREATE INDEX "matches_kickoff_idx" ON "matches"("kickoff");

-- CreateIndex
CREATE INDEX "matches_status_kickoff_idx" ON "matches"("status", "kickoff");

-- CreateIndex
CREATE INDEX "matches_homeTeamId_kickoff_idx" ON "matches"("homeTeamId", "kickoff");

-- CreateIndex
CREATE INDEX "matches_awayTeamId_kickoff_idx" ON "matches"("awayTeamId", "kickoff");

-- CreateIndex
CREATE UNIQUE INDEX "matches_sportId_externalId_key" ON "matches"("sportId", "externalId");

-- CreateIndex
CREATE INDEX "match_events_matchId_idx" ON "match_events"("matchId");

-- CreateIndex
CREATE INDEX "team_statistics_teamId_idx" ON "team_statistics"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "team_statistics_matchId_teamId_key" ON "team_statistics"("matchId", "teamId");

-- CreateIndex
CREATE INDEX "player_statistics_playerId_idx" ON "player_statistics"("playerId");

-- CreateIndex
CREATE UNIQUE INDEX "player_statistics_matchId_playerId_key" ON "player_statistics"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "player_availability_matchId_idx" ON "player_availability"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "player_availability_matchId_playerId_key" ON "player_availability"("matchId", "playerId");

-- CreateIndex
CREATE INDEX "odds_matchId_market_idx" ON "odds"("matchId", "market");

-- CreateIndex
CREATE INDEX "odds_capturedAt_idx" ON "odds"("capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "odds_matchId_bookmaker_market_selection_line_capturedAt_key" ON "odds"("matchId", "bookmaker", "market", "selection", "line", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_version_key" ON "model_versions"("version");

-- CreateIndex
CREATE INDEX "model_versions_sportKey_active_idx" ON "model_versions"("sportKey", "active");

-- CreateIndex
CREATE INDEX "predictions_matchId_idx" ON "predictions"("matchId");

-- CreateIndex
CREATE INDEX "predictions_predictedAt_idx" ON "predictions"("predictedAt");

-- CreateIndex
CREATE UNIQUE INDEX "predictions_matchId_modelVersionId_key" ON "predictions"("matchId", "modelVersionId");

-- CreateIndex
CREATE INDEX "prediction_outcomes_predictionId_market_idx" ON "prediction_outcomes"("predictionId", "market");

-- CreateIndex
CREATE INDEX "prediction_outcomes_market_expectedValue_idx" ON "prediction_outcomes"("market", "expectedValue");

-- CreateIndex
CREATE INDEX "prediction_features_predictionId_idx" ON "prediction_features"("predictionId");

-- CreateIndex
CREATE INDEX "model_component_outcomes_predictionId_component_idx" ON "model_component_outcomes"("predictionId", "component");

-- CreateIndex
CREATE INDEX "team_ratings_teamId_asOf_idx" ON "team_ratings"("teamId", "asOf");

-- CreateIndex
CREATE UNIQUE INDEX "team_ratings_teamId_asOf_key" ON "team_ratings"("teamId", "asOf");

-- CreateIndex
CREATE INDEX "model_performance_modelVersionId_idx" ON "model_performance"("modelVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "model_performance_modelVersionId_sportKey_leagueKey_confide_key" ON "model_performance"("modelVersionId", "sportKey", "leagueKey", "confidence", "market", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "backtests_sportKey_createdAt_idx" ON "backtests"("sportKey", "createdAt");

-- CreateIndex
CREATE INDEX "bets_userId_placedAt_idx" ON "bets"("userId", "placedAt");

-- CreateIndex
CREATE INDEX "bets_matchId_idx" ON "bets"("matchId");

-- CreateIndex
CREATE INDEX "bets_result_idx" ON "bets"("result");

-- CreateIndex
CREATE INDEX "ingestion_runs_provider_startedAt_idx" ON "ingestion_runs"("provider", "startedAt");

-- AddForeignKey
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "sports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "sports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "sports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_leagueId_fkey" FOREIGN KEY ("leagueId") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_homeTeamId_fkey" FOREIGN KEY ("homeTeamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_awayTeamId_fkey" FOREIGN KEY ("awayTeamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_statistics" ADD CONSTRAINT "team_statistics_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_statistics" ADD CONSTRAINT "team_statistics_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_statistics" ADD CONSTRAINT "player_statistics_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_availability" ADD CONSTRAINT "player_availability_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "player_availability" ADD CONSTRAINT "player_availability_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds" ADD CONSTRAINT "odds_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_outcomes" ADD CONSTRAINT "prediction_outcomes_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prediction_features" ADD CONSTRAINT "prediction_features_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_component_outcomes" ADD CONSTRAINT "model_component_outcomes_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_ratings" ADD CONSTRAINT "team_ratings_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_performance" ADD CONSTRAINT "model_performance_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "model_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bets" ADD CONSTRAINT "bets_predictionId_fkey" FOREIGN KEY ("predictionId") REFERENCES "predictions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

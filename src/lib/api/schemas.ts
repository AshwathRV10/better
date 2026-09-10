/** Request validation schemas shared by the API routes. */

import { z } from 'zod';

export const sportKeySchema = z.enum(['football', 'tennis', 'basketball']);

export const marketSchema = z.enum([
  'MATCH_WINNER', 'OVER_UNDER', 'BTTS', 'CORRECT_SCORE', 'ASIAN_HANDICAP',
  'POINT_SPREAD', 'SET_WINNER', 'TOTAL_GAMES', 'HANDICAP_GAMES',
]);

export const confidenceSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

/** An ISO date (YYYY-MM-DD) or a full timestamp. */
const dateString = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a valid ISO date')
  .transform((value) => new Date(value));

export const matchesQuerySchema = z.object({
  sport: sportKeySchema.optional(),
  league: z.string().min(1).max(80).optional(),
  date: dateString.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  status: z.enum(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const valueQuerySchema = z.object({
  sport: sportKeySchema.optional(),
  league: z.string().min(1).max(80).optional(),
  market: marketSchema.optional(),
  date: dateString.optional(),
  minProbability: z.coerce.number().min(0).max(1).default(0),
  minEdge: z.coerce.number().min(-1).max(1).default(0),
  minEv: z.coerce.number().min(-1).max(10).default(0.02),
  confidence: confidenceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const predictionsQuerySchema = z.object({
  sport: sportKeySchema.optional(),
  league: z.string().min(1).max(80).optional(),
  date: dateString.optional(),
  confidence: confidenceSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createPredictionSchema = z.object({
  matchId: z.string().min(1).max(64),
  force: z.boolean().optional().default(false),
});

export const createBetSchema = z.object({
  matchId: z.string().min(1).max(64),
  predictionId: z.string().min(1).max(64).optional(),
  market: marketSchema,
  selection: z.string().min(1).max(32),
  line: z.number().finite().optional(),
  odds: z.number().gt(1).max(1000),
  stake: z.number().gt(0).max(1_000_000),
  stakingMethod: z.enum(['FLAT', 'PERCENT_BANKROLL', 'FRACTIONAL_KELLY']).default('FLAT'),
  notes: z.string().max(500).optional(),
});

export const settleBetSchema = z.object({
  result: z.enum(['WON', 'LOST', 'PUSH', 'VOID']),
});

export const betsQuerySchema = z.object({
  result: z.enum(['PENDING', 'WON', 'LOST', 'PUSH', 'VOID']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const performanceQuerySchema = z.object({
  sport: sportKeySchema.optional(),
  league: z.string().min(1).max(80).optional(),
  confidence: confidenceSchema.optional(),
});

export const ingestSchema = z.object({
  seed: z.number().int().optional(),
  train: z.boolean().optional().default(false),
});

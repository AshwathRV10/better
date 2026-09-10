import { prisma } from '@/lib/db/prisma';
import { generatePrediction, matchInclude } from '@/lib/services/predictions';
import { ok, parseBody, parseQuery, requireApiKey, route } from '@/lib/api/http';
import { createPredictionSchema, predictionsQuerySchema } from '@/lib/api/schemas';
import { notFound } from '@/lib/errors';
import { listMatches } from '@/lib/services/queries';

export const dynamic = 'force-dynamic';

/** Upcoming fixtures that already carry a prediction. */
export const GET = route(async (request) => {
  const query = parseQuery(request, predictionsQuerySchema);
  const { matches, total } = await listMatches({
    sportKey: query.sport,
    leagueKey: query.league,
    date: query.date,
    from: query.date ? undefined : new Date(),
    status: 'SCHEDULED',
    limit: query.limit,
    offset: query.offset,
  });

  const withPredictions = matches.filter(
    (match) =>
      match.prediction !== null &&
      (!query.confidence || match.prediction.confidence === query.confidence),
  );
  return ok(withPredictions, { total, limit: query.limit, offset: query.offset });
});

/** Generates (or regenerates) a prediction for one match. */
export const POST = route(async (request) => {
  requireApiKey(request);
  const body = await parseBody(request, createPredictionSchema);

  const match = await prisma.match.findUnique({
    where: { id: body.matchId },
    include: matchInclude,
  });
  if (!match) throw notFound(`No match with id ${body.matchId}`);

  const { prediction, priced, predictionId } = await generatePrediction(match, { force: body.force });
  return ok(
    {
      predictionId,
      matchId: match.id,
      modelVersion: prediction.modelVersion,
      featuresVersion: prediction.featuresVersion,
      predictedAt: prediction.predictedAt.toISOString(),
      dataTimestamp: prediction.dataTimestamp.toISOString(),
      confidence: prediction.confidence,
      dataQuality: prediction.dataQuality,
      outcomes: priced,
    },
    {},
    { status: 201 },
  );
});

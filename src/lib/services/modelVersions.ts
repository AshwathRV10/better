/**
 * Model version management.
 *
 * Every prediction is tied to a `ModelVersion` row that stores the exact
 * parameters used - ensemble weights, Elo settings, trained ML coefficients and
 * the calibration fit. Storing them (rather than reading today's constants)
 * is what makes a prediction from three months ago reproducible.
 */

import type { ModelVersion, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getSportModule } from '../prediction/sports/registry';
import type { ModelParameters, SportKey } from '../prediction/types';

/** Bumped when the engine's behaviour changes in a way that affects output. */
export const ENGINE_VERSION = '1.0.0';

export function defaultVersionName(sportKey: SportKey): string {
  return `${sportKey}-ensemble-${ENGINE_VERSION}`;
}

/**
 * Returns the active model version for a sport, creating it from the sport
 * module's defaults on first use.
 */
export async function getActiveModelVersion(sportKey: SportKey): Promise<ModelVersion> {
  const existing = await prisma.modelVersion.findFirst({
    where: { sportKey, active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  const sportModule = getSportModule(sportKey);
  return prisma.modelVersion.create({
    data: {
      version: defaultVersionName(sportKey),
      sportKey,
      name: `${sportKey} ensemble`,
      description:
        `Ensemble of ${Object.keys(sportModule.defaultParameters.ensembleWeights).join(', ')} ` +
        'components with temperature-scaled calibration.',
      parameters: sportModule.defaultParameters as unknown as Prisma.InputJsonValue,
      active: true,
    },
  });
}

/**
 * Reads stored parameters back into the engine's shape.
 *
 * Falls back to the sport module's defaults for anything the stored record is
 * missing, so an older row written before a parameter existed still loads.
 */
export function loadModelParameters(
  modelVersion: Pick<ModelVersion, 'parameters'>,
  sportKey: SportKey,
): ModelParameters {
  const defaults = getSportModule(sportKey).defaultParameters;
  const stored = modelVersion.parameters as unknown;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;

  const parsed = stored as Partial<ModelParameters>;
  return {
    ensembleWeights: parsed.ensembleWeights ?? defaults.ensembleWeights,
    calibration: parsed.calibration ?? defaults.calibration,
    ml: parsed.ml ?? defaults.ml,
    elo: parsed.elo ?? defaults.elo,
    form: parsed.form ?? defaults.form,
  };
}

/** Persists a newly trained parameter set onto a model version. */
export async function saveModelParameters(
  modelVersionId: string,
  parameters: ModelParameters,
  meta: { trainedThrough?: Date; trainingSampleSize?: number } = {},
): Promise<ModelVersion> {
  return prisma.modelVersion.update({
    where: { id: modelVersionId },
    data: {
      parameters: parameters as unknown as Prisma.InputJsonValue,
      trainedAt: new Date(),
      trainedThrough: meta.trainedThrough ?? null,
      trainingSampleSize: meta.trainingSampleSize ?? null,
    },
  });
}

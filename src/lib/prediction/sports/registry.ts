/**
 * Sport registry.
 *
 * Adding a sport means writing one `SportModule` and registering it here. No
 * other part of the application needs to change: the engine, the API and the UI
 * all work from the module's declared markets and classes.
 */

import type { SportKey, SportModule } from '../types';
import { footballModule } from './football';
import { tennisModule } from './tennis';
import { basketballModule } from './basketball';

const MODULES: Readonly<Record<SportKey, SportModule>> = {
  football: footballModule,
  tennis: tennisModule,
  basketball: basketballModule,
};

export function getSportModule(key: string): SportModule {
  const sportModule = MODULES[key as SportKey];
  if (!sportModule) {
    throw new Error(`Unsupported sport "${key}". Registered sports: ${Object.keys(MODULES).join(', ')}`);
  }
  return sportModule;
}

export function hasSportModule(key: string): key is SportKey {
  return key in MODULES;
}

export function listSportModules(): readonly SportModule[] {
  return Object.values(MODULES);
}

export const SPORT_KEYS = Object.keys(MODULES) as readonly SportKey[];

/**
 * Deterministic bucketing. The core requirement of a percentage rollout is that the
 * same subject lands in the same bucket for the same flag every single time, on every
 * server, with no shared state — otherwise raising a rollout from 10% to 20% would
 * silently drop users who were already enabled.
 */

/** 32-bit FNV-1a. Fast, dependency-free, and stable across runs and machines. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Rollouts are expressed in 1/1000 of a percent: 100_000 means "everyone". */
export const BUCKETS = 100_000;

export function bucketFor(flagKey: string, subjectId: string): number {
  return fnv1a32(`${flagKey}:${subjectId}`) % BUCKETS;
}

export function percentToBuckets(percent: number): number {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`percent must be between 0 and 100, received ${percent}`);
  }
  return Math.round((percent / 100) * BUCKETS);
}

export function bucketsToPercent(buckets: number): number {
  return (buckets / BUCKETS) * 100;
}

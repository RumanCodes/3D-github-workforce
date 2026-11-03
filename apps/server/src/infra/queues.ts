export const NORMALIZE_QUEUE = 'normalize';
export const BACKFILL_QUEUE = 'backfill';

export const normalizeJobOptions = (rawId: string) => ({
  jobId: `raw-${rawId}`, // BullMQ dedupes on jobId
  attempts: 8,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
});

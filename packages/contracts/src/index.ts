import { z } from 'zod';

/**
 * Shared contracts between server and web.
 * Every status shown in the UI carries a provenance so inferences are never shown as facts.
 */

export const Provenance = z.enum(['VERIFIED', 'POLLED', 'SELF_REPORTED', 'INFERRED']);
export type Provenance = z.infer<typeof Provenance>;

export const Activity = z.enum([
  'CODING',
  'REVIEWING',
  'MERGING',
  'FIXING_CI',
  'RELEASING',
  'TRIAGING',
  'CELEBRATING',
  'BLOCKED',
  'NONE',
]);
export type Activity = z.infer<typeof Activity>;

export const Role = z.enum(['ADMIN', 'LEAD', 'MEMBER']);
export type Role = z.infer<typeof Role>;

/** A canonical event, as stored in the event log and shown in the live feed. */
export const FeedEvent = z.object({
  live: z.boolean().optional(),
  id: z.string(),
  verb: z.string(),
  occurredAt: z.string(),
  provenance: Provenance,
  actor: z
    .object({ id: z.string().nullable(), name: z.string(), avatarUrl: z.string().nullable() })
    .nullable(),
  repo: z.string().nullable(),
  subject: z.string(),
  url: z.string().nullable(),
  summary: z.string(),
});
export type FeedEvent = z.infer<typeof FeedEvent>;

export const AgentStateDTO = z.object({
  employeeId: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
  team: z.string().nullable(),
  activity: Activity,
  provenance: Provenance,
  source: z
    .object({ verb: z.string(), occurredAt: z.string(), url: z.string().nullable(), label: z.string() })
    .nullable(),
  expiresAt: z.string().nullable(),
});
export type AgentStateDTO = z.infer<typeof AgentStateDTO>;

export const PullRequestDTO = z.object({
  id: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.object({ id: z.string().nullable(), name: z.string(), avatarUrl: z.string().nullable() }),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  draft: z.boolean(),
  ciState: z.enum(['SUCCESS', 'FAILURE', 'PENDING', 'NONE']),
  size: z.number(),
  createdAt: z.string(),
  readyAt: z.string().nullable(),
  firstReviewAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  lastActivityAt: z.string(),
  requestedReviewers: z.array(z.string()),
  waitingHours: z.number().nullable(),
});
export type PullRequestDTO = z.infer<typeof PullRequestDTO>;

export const RealtimeMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), seq: z.number(), event: FeedEvent }),
  z.object({ type: z.literal('agent'), seq: z.number(), agent: AgentStateDTO }),
  z.object({ type: z.literal('pr'), seq: z.number(), pr: PullRequestDTO }),
]);
export type RealtimeMessage = z.infer<typeof RealtimeMessage>;

export const Overview = z.object({
  openPrs: z.number(),
  awaitingReview: z.number(),
  failingCi: z.number(),
  mergedThisWeek: z.number(),
  mergedLastWeek: z.number(),
  pickupHoursP50: z.number().nullable(),
  cycleHoursP50: z.number().nullable(),
  ciPassRate: z.number().nullable(),
  lastEventAt: z.string().nullable(),
});
export type Overview = z.infer<typeof Overview>;

export const FlowWeek = z.object({
  weekStart: z.string(),
  merged: z.number(),
  draftHoursP50: z.number().nullable(),
  pickupHoursP50: z.number().nullable(),
  reviewHoursP50: z.number().nullable(),
  mergeHoursP50: z.number().nullable(),
});
export type FlowWeek = z.infer<typeof FlowWeek>;

export const SizeBucket = z.object({
  bucket: z.string(),
  count: z.number(),
  pickupHoursP50: z.number().nullable(),
});
export type SizeBucket = z.infer<typeof SizeBucket>;

export const ReviewerLoad = z.object({
  employeeId: z.string(),
  name: z.string(),
  reviews: z.number(),
  approvals: z.number(),
  changesRequested: z.number(),
  pendingRequests: z.number(),
  responseHoursP50: z.number().nullable(),
});
export type ReviewerLoad = z.infer<typeof ReviewerLoad>;

export const ReviewPair = z.object({ author: z.string(), reviewer: z.string(), count: z.number() });
export type ReviewPair = z.infer<typeof ReviewPair>;

export const WorkflowHealth = z.object({
  repo: z.string(),
  workflow: z.string(),
  runs: z.number(),
  passRate: z.number(),
  durationMinP50: z.number().nullable(),
  flakyRuns: z.number(),
  lastConclusion: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastRunUrl: z.string().nullable(),
});
export type WorkflowHealth = z.infer<typeof WorkflowHealth>;

/** Request bodies (validated server-side). */
export const LinkIdentityBody = z.object({
  githubId: z.string().regex(/^\d+$/),
  employeeId: z.string().min(1),
});
export const BackfillBody = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  days: z.number().int().min(1).max(365).default(60),
});
export const StatusReportBody = z.object({
  activity: z.enum(['BLOCKED', 'NONE']),
  note: z.string().max(280).optional(),
});

/** The snapshot and replay cursor are read in the same database transaction. */
export const OfficeSnapshot = z.object({ agents: z.array(AgentStateDTO), feed: z.array(FeedEvent), cursor: z.number().int().nonnegative() });
export type OfficeSnapshot = z.infer<typeof OfficeSnapshot>;
export const OfficeLayout = z.object({
  desks: z.array(z.object({ employeeId: z.string(), seat: z.number().int().positive(), zone: z.number().int().nonnegative().optional(), slot: z.number().int().nonnegative().optional() })),
  products: z.array(z.object({ id: z.string(), name: z.string(), repositories: z.array(z.string()), openPrs: z.number().optional(), awaitingReview: z.number().optional(), failingCi: z.number().optional(), latestRelease: z.string().nullable().optional() })),
  repositories: z.array(z.object({ id: z.string(), name: z.string(), productId: z.string().nullable(), connected: z.boolean(), lastPolledAt: z.string().nullable().optional(), pollError: z.string().nullable().optional() })),
});
export type OfficeLayout = z.infer<typeof OfficeLayout>;

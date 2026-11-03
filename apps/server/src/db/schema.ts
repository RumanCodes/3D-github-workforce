/**
 * Live Workforce — GitHub edition.
 * Layers: organization → identity → immutable event log → projections (rebuildable from events).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  serial,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const roleEnum = pgEnum('role', ['ADMIN', 'LEAD', 'MEMBER']);
export const provenanceEnum = pgEnum('provenance', ['VERIFIED', 'POLLED', 'SELF_REPORTED', 'INFERRED']);
export const rawStatusEnum = pgEnum('raw_status', ['PENDING', 'NORMALIZED', 'IGNORED', 'FAILED']);
export const prStateEnum = pgEnum('pr_state', ['OPEN', 'MERGED', 'CLOSED']);
export const ciStateEnum = pgEnum('ci_state', ['SUCCESS', 'FAILURE', 'PENDING', 'NONE']);

// ---------- Organization ----------

export const teams = pgTable('teams', {
  id: id(),
  officeZone: serial('office_zone').notNull(),
  name: text('name').notNull().unique(),
  department: text('department').notNull(), // Support, Development, UI/UX, Motion Graphics, Marketing
});

export const employees = pgTable('employees', {
  id: id(),
  email: text('email').unique(),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  role: roleEnum('role').notNull().default('MEMBER'),
  teamId: text('team_id').references(() => teams.id),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the random cookie token
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('sessions_employee_idx').on(t.employeeId)],
);

/** One person, many accounts. GitHub numeric id (never the login, which can be renamed). */
export const externalIdentities = pgTable(
  'external_identities',
  {
    id: id(),
    employeeId: text('employee_id').references(() => employees.id),
    source: text('source').notNull(), // GITHUB
    externalId: text('external_id').notNull(),
    handle: text('handle').notNull(),
    avatarUrl: text('avatar_url'),
    verifiedBy: text('verified_by'), // OAUTH | ADMIN
    firstSeen: ts('first_seen').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('ext_identity_source_ext_uq').on(t.source, t.externalId)],
);

export const products = pgTable('products', { id: id(), name: text('name').notNull().unique() });
export const githubInstallations = pgTable('github_installations', {
  id: bigint('id', { mode: 'number' }).primaryKey(),
  login: text('login').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  syncedAt: ts('synced_at'),
});

export const repositories = pgTable('repositories', {
  id: id(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  productId: text('product_id').references(() => products.id),
  pollCursor: ts('poll_cursor'),
  pollError: text('poll_error'),
  connected: boolean('connected').notNull().default(true),
  fullName: text('full_name').notNull().unique(),
  defaultBranch: text('default_branch').notNull().default('main'),
  private: boolean('private').notNull().default(true),
});

// ---------- Immutable event log ----------

export const rawEvents = pgTable(
  'raw_events',
  {
    id: id(),
    source: text('source').notNull(), // GITHUB | GITHUB_BACKFILL | SELF_REPORT
    externalEventId: text('external_event_id').notNull(), // X-GitHub-Delivery or deterministic backfill id
    eventType: text('event_type').notNull(),
    receivedAt: ts('received_at').notNull().defaultNow(),
    payload: jsonb('payload').notNull(),
    status: rawStatusEnum('status').notNull().default('PENDING'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    uniqueIndex('raw_source_ext_uq').on(t.source, t.externalEventId),
    index('raw_status_idx').on(t.status, t.receivedAt),
  ],
);

export const events = pgTable(
  'events',
  {
    id: id(),
    rawEventId: text('raw_event_id'),
    dedupeKey: text('dedupe_key').notNull().unique(), // semantic: webhook + backfill of one fact collapse
    occurredAt: ts('occurred_at').notNull(), // GitHub's own timestamp, not receipt time
    recordedAt: ts('recorded_at').notNull().defaultNow(),
    actorId: text('actor_id'), // employee; null until the identity is linked
    actorExtId: text('actor_ext_id'), // GitHub user id, kept for re-attribution
    verb: text('verb').notNull(),
    repoId: text('repo_id'),
    subjectType: text('subject_type').notNull(), // PR, REVIEW, CI_RUN, PUSH, RELEASE, ISSUE, STATUS
    subjectId: text('subject_id').notNull(),
    provenance: provenanceEnum('provenance').notNull(),
    url: text('url'),
    summary: text('summary').notNull(),
    data: jsonb('data').notNull().default({}),
  },
  (t) => [
    index('events_occurred_idx').on(t.occurredAt),
    index('events_actor_idx').on(t.actorId, t.occurredAt),
    index('events_actor_ext_idx').on(t.actorExtId),
    index('events_verb_idx').on(t.verb, t.occurredAt),
  ],
);

// ---------- Projections (derived; rebuildable from events) ----------

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: id(),
    repoId: text('repo_id')
      .notNull()
      .references(() => repositories.id),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    url: text('url').notNull(),
    authorExtId: text('author_ext_id').notNull(),
    authorId: text('author_id'),
    state: prStateEnum('state').notNull().default('OPEN'),
    stateChangedAt: ts('state_changed_at').notNull(),
    draft: boolean('draft').notNull().default(false),
    headSha: text('head_sha'),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    createdAt: ts('created_at').notNull(),
    readyAt: ts('ready_at'),
    firstReviewAt: ts('first_review_at'),
    approvedAt: ts('approved_at'),
    mergedAt: ts('merged_at'),
    closedAt: ts('closed_at'),
    mergedByExtId: text('merged_by_ext_id'),
    requestedReviewers: text('requested_reviewers').array().notNull().default([]),
    ciState: ciStateEnum('ci_state').notNull().default('NONE'),
    ciUpdatedAt: ts('ci_updated_at'),
    lastActivityAt: ts('last_activity_at').notNull(),
    snapshotAt: ts('snapshot_at').notNull(), // updated_at of the newest PR snapshot applied
  },
  (t) => [
    uniqueIndex('pr_repo_number_uq').on(t.repoId, t.number),
    index('pr_state_idx').on(t.state, t.lastActivityAt),
    index('pr_merged_idx').on(t.mergedAt),
    index('pr_author_idx').on(t.authorId),
    index('pr_head_sha_idx').on(t.headSha),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
    prId: text('pr_id')
      .notNull()
      .references(() => pullRequests.id),
    reviewerExtId: text('reviewer_ext_id').notNull(),
    reviewerId: text('reviewer_id'),
    state: text('state').notNull(), // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
    submittedAt: ts('submitted_at').notNull(),
  },
  (t) => [
    index('reviews_reviewer_idx').on(t.reviewerId, t.submittedAt),
    index('reviews_reviewer_ext_idx').on(t.reviewerExtId),
    index('reviews_pr_idx').on(t.prId),
  ],
);

export const ciRuns = pgTable(
  'ci_runs',
  {
    id: id(),
    githubId: bigint('github_id', { mode: 'number' }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    repoId: text('repo_id')
      .notNull()
      .references(() => repositories.id),
    workflowName: text('workflow_name').notNull(),
    headSha: text('head_sha').notNull(),
    headBranch: text('head_branch'),
    event: text('event'),
    conclusion: text('conclusion'),
    startedAt: ts('started_at').notNull(),
    completedAt: ts('completed_at'),
    url: text('url').notNull(),
    prNumbers: integer('pr_numbers').array().notNull().default([]),
  },
  (t) => [
    uniqueIndex('ci_run_attempt_uq').on(t.githubId, t.attempt),
    index('ci_repo_workflow_idx').on(t.repoId, t.workflowName, t.startedAt),
    index('ci_head_sha_idx').on(t.headSha),
  ],
);

export const agentStates = pgTable('agent_states', {
  employeeId: text('employee_id')
    .primaryKey()
    .references(() => employees.id, { onDelete: 'cascade' }),
  activity: text('activity').notNull(),
  provenance: provenanceEnum('provenance').notNull(),
  sourceVerb: text('source_verb').notNull(),
  sourceLabel: text('source_label').notNull(),
  sourceUrl: text('source_url'),
  occurredAt: ts('occurred_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ---------- Delivery and audit ----------

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    topic: text('topic').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
  },
  (t) => [index('outbox_unpublished_idx').on(t.publishedAt, t.id)],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    actorId: text('actor_id').notNull(),
    action: text('action').notNull(), // VIEW_PERSON_METRICS, LINK_IDENTITY, BACKFILL, REPLAY
    target: text('target').notNull(),
    meta: jsonb('meta').notNull().default({}),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_target_idx').on(t.target, t.at), index('audit_actor_idx').on(t.actorId, t.at)],
);

export const officeDesks = pgTable(
  'office_desks',
  {
    employeeId: text('employee_id')
      .primaryKey()
      .references(() => employees.id),
    seat: serial('seat').notNull().unique(),
    teamId: text('team_id').references(() => teams.id),
    teamSlot: integer('team_slot'),
  },
  (t) => [
    uniqueIndex('office_team_slot')
      .on(sql`coalesce(${t.teamId},'')`, t.teamSlot)
      .where(sql`${t.teamSlot} IS NOT NULL`),
  ],
);

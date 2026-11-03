CREATE TYPE "public"."ci_state" AS ENUM('SUCCESS', 'FAILURE', 'PENDING', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."pr_state" AS ENUM('OPEN', 'MERGED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('VERIFIED', 'POLLED', 'SELF_REPORTED', 'INFERRED');--> statement-breakpoint
CREATE TYPE "public"."raw_status" AS ENUM('PENDING', 'NORMALIZED', 'IGNORED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'LEAD', 'MEMBER');--> statement-breakpoint
CREATE TABLE "agent_states" (
	"employee_id" text PRIMARY KEY NOT NULL,
	"activity" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"source_verb" text NOT NULL,
	"source_label" text NOT NULL,
	"source_url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ci_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"repo_id" text NOT NULL,
	"workflow_name" text NOT NULL,
	"head_sha" text NOT NULL,
	"head_branch" text,
	"event" text,
	"conclusion" text,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"url" text NOT NULL,
	"pr_numbers" integer[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"role" "role" DEFAULT 'MEMBER' NOT NULL,
	"team_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"raw_event_id" text,
	"dedupe_key" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_ext_id" text,
	"verb" text NOT NULL,
	"repo_id" text,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"provenance" "provenance" NOT NULL,
	"url" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "events_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "external_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"handle" text NOT NULL,
	"avatar_url" text,
	"verified_by" text,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"author_ext_id" text NOT NULL,
	"author_id" text,
	"state" "pr_state" DEFAULT 'OPEN' NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"head_sha" text,
	"additions" integer DEFAULT 0 NOT NULL,
	"deletions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"ready_at" timestamp with time zone,
	"first_review_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"merged_by_ext_id" text,
	"requested_reviewers" text[] DEFAULT '{}' NOT NULL,
	"ci_state" "ci_state" DEFAULT 'NONE' NOT NULL,
	"ci_updated_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "raw_status" DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"private" boolean DEFAULT true NOT NULL,
	CONSTRAINT "repositories_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "repositories_full_name_unique" UNIQUE("full_name")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"pr_id" text NOT NULL,
	"reviewer_ext_id" text NOT NULL,
	"reviewer_id" text,
	"state" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reviews_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"employee_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"department" text NOT NULL,
	CONSTRAINT "teams_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "agent_states" ADD CONSTRAINT "agent_states_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_runs" ADD CONSTRAINT "ci_runs_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_target_idx" ON "audit_log" USING btree ("target","at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "ci_run_attempt_uq" ON "ci_runs" USING btree ("github_id","attempt");--> statement-breakpoint
CREATE INDEX "ci_repo_workflow_idx" ON "ci_runs" USING btree ("repo_id","workflow_name","started_at");--> statement-breakpoint
CREATE INDEX "ci_head_sha_idx" ON "ci_runs" USING btree ("head_sha");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "events_actor_idx" ON "events" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_actor_ext_idx" ON "events" USING btree ("actor_ext_id");--> statement-breakpoint
CREATE INDEX "events_verb_idx" ON "events" USING btree ("verb","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ext_identity_source_ext_uq" ON "external_identities" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("published_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "pr_repo_number_uq" ON "pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "pr_state_idx" ON "pull_requests" USING btree ("state","last_activity_at");--> statement-breakpoint
CREATE INDEX "pr_merged_idx" ON "pull_requests" USING btree ("merged_at");--> statement-breakpoint
CREATE INDEX "pr_author_idx" ON "pull_requests" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "pr_head_sha_idx" ON "pull_requests" USING btree ("head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_source_ext_uq" ON "raw_events" USING btree ("source","external_event_id");--> statement-breakpoint
CREATE INDEX "raw_status_idx" ON "raw_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_idx" ON "reviews" USING btree ("reviewer_id","submitted_at");--> statement-breakpoint
CREATE INDEX "reviews_reviewer_ext_idx" ON "reviews" USING btree ("reviewer_ext_id");--> statement-breakpoint
CREATE INDEX "reviews_pr_idx" ON "reviews" USING btree ("pr_id");--> statement-breakpoint
CREATE INDEX "sessions_employee_idx" ON "sessions" USING btree ("employee_id");
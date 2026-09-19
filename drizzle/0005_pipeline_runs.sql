CREATE TABLE `pipeline_run_items` (
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`steam_app_id` text NOT NULL,
	`game_id` integer,
	`current_stage` text NOT NULL,
	`current_state` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`stage_states_json` text NOT NULL,
	`reason_code` text,
	`retry_class` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `ordinal`),
	FOREIGN KEY (`run_id`) REFERENCES `pipeline_runs`(`run_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pipeline_items_ordinal_check" CHECK("pipeline_run_items"."ordinal" > 0),
	CONSTRAINT "pipeline_items_steam_app_id_check" CHECK(length("pipeline_run_items"."steam_app_id") > 0 and "pipeline_run_items"."steam_app_id" not glob '*[^0-9]*' and substr("pipeline_run_items"."steam_app_id", 1, 1) <> '0'),
	CONSTRAINT "pipeline_items_stage_check" CHECK("pipeline_run_items"."current_stage" in ('discover', 'import', 'enrich', 'verify', 'images', 'evaluate')),
	CONSTRAINT "pipeline_items_state_check" CHECK("pipeline_run_items"."current_state" in ('pending', 'running', 'succeeded', 'retryable_failed', 'permanently_failed', 'blocked', 'skipped')),
	CONSTRAINT "pipeline_items_attempt_count_check" CHECK("pipeline_run_items"."attempt_count" >= 0 and "pipeline_run_items"."attempt_count" <= 3),
	CONSTRAINT "pipeline_items_retry_class_check" CHECK("pipeline_run_items"."retry_class" is null or "pipeline_run_items"."retry_class" in ('none', 'retryable', 'permanent', 'blocked', 'run_fatal'))
);
--> statement-breakpoint
CREATE INDEX `pipeline_items_pending_idx` ON `pipeline_run_items` (`run_id`,`current_stage`,`current_state`,`ordinal`);--> statement-breakpoint
CREATE INDEX `pipeline_items_retryable_idx` ON `pipeline_run_items` (`run_id`,`current_state`,`ordinal`);--> statement-breakpoint
CREATE INDEX `pipeline_items_game_idx` ON `pipeline_run_items` (`game_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_run_items_run_id_steam_app_id_unique` ON `pipeline_run_items` (`run_id`,`steam_app_id`);--> statement-breakpoint
CREATE TABLE `pipeline_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`manifest_hash` text NOT NULL,
	`pipeline_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`status` text NOT NULL,
	`current_stage` text,
	`run_stage_states_json` text NOT NULL,
	`artifact_sha256` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "pipeline_runs_manifest_hash_check" CHECK(length("pipeline_runs"."manifest_hash") = 64),
	CONSTRAINT "pipeline_runs_version_check" CHECK("pipeline_runs"."pipeline_version" = '2.10'),
	CONSTRAINT "pipeline_runs_policy_version_check" CHECK(length("pipeline_runs"."policy_version") between 1 and 32),
	CONSTRAINT "pipeline_runs_snapshot_date_check" CHECK("pipeline_runs"."snapshot_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "pipeline_runs_status_check" CHECK("pipeline_runs"."status" in ('created', 'running', 'paused', 'failed', 'ready')),
	CONSTRAINT "pipeline_runs_stage_check" CHECK("pipeline_runs"."current_stage" is null or "pipeline_runs"."current_stage" in ('export', 'preview', 'publish-ready')),
	CONSTRAINT "pipeline_runs_artifact_hash_check" CHECK("pipeline_runs"."artifact_sha256" is null or (length("pipeline_runs"."artifact_sha256") = 64 and "pipeline_runs"."artifact_sha256" not glob '*[^0-9a-f]*')),
	CONSTRAINT "pipeline_runs_timestamps_check" CHECK("pipeline_runs"."updated_at" >= "pipeline_runs"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pipeline_runs_manifest_hash_unique` ON `pipeline_runs` (`manifest_hash`);--> statement-breakpoint
CREATE INDEX `pipeline_runs_status_idx` ON `pipeline_runs` (`status`,`updated_at`,`run_id`);
CREATE TABLE `game_cron_sync_state` (
	`game_id` integer PRIMARY KEY NOT NULL,
	`last_attempt_at` integer NOT NULL,
	`last_status` text NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_cron_sync_state_attempt_check" CHECK(typeof("game_cron_sync_state"."last_attempt_at") = 'integer' and "game_cron_sync_state"."last_attempt_at" >= 0),
	CONSTRAINT "game_cron_sync_state_status_check" CHECK("game_cron_sync_state"."last_status" in ('started', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `game_cron_sync_state_attempt_idx` ON `game_cron_sync_state` (`last_attempt_at`,`game_id`);
--> statement-breakpoint
CREATE TABLE `cron_sync_lease` (
	`name` text PRIMARY KEY NOT NULL,
	`lease_owner_token` text,
	`lease_expires_at` integer DEFAULT 0 NOT NULL,
	`fence_epoch` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "cron_sync_lease_name_check" CHECK("cron_sync_lease"."name" = 'game-sync'),
	CONSTRAINT "cron_sync_lease_expiry_check" CHECK(typeof("cron_sync_lease"."lease_expires_at") = 'integer' and "cron_sync_lease"."lease_expires_at" >= 0),
	CONSTRAINT "cron_sync_lease_epoch_check" CHECK(typeof("cron_sync_lease"."fence_epoch") = 'integer' and "cron_sync_lease"."fence_epoch" >= 0 and "cron_sync_lease"."fence_epoch" <= 9007199254740991),
	CONSTRAINT "cron_sync_lease_owner_check" CHECK((
      "cron_sync_lease"."lease_owner_token" is null and "cron_sync_lease"."lease_expires_at" = 0
    ) or (
      typeof("cron_sync_lease"."lease_owner_token") = 'text'
      and length("cron_sync_lease"."lease_owner_token") > 0
      and "cron_sync_lease"."lease_expires_at" > 0
    ))
);
--> statement-breakpoint
INSERT INTO `cron_sync_lease` (`name`,`lease_owner_token`,`lease_expires_at`,`fence_epoch`)
VALUES ('game-sync',NULL,0,0);

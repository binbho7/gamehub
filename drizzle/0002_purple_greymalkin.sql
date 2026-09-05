PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_game_official_links` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`provider` text NOT NULL,
	`platform` text,
	`link_type` text NOT NULL,
	`url` text NOT NULL,
	`region` text,
	`is_official` integer DEFAULT true NOT NULL,
	`verification_status` text DEFAULT 'unverified' NOT NULL,
	`verification_method` text,
	`http_status` integer,
	`redirect_url` text,
	`verified_at` integer,
	`last_checked_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_official_links_type_check" CHECK("__new_game_official_links"."link_type" in ('official_website', 'store', 'purchase', 'download', 'demo', 'launcher')),
	CONSTRAINT "game_official_links_status_check" CHECK("__new_game_official_links"."verification_status" in ('unverified', 'pending', 'verified', 'failed', 'reachable_but_unverified', 'broken', 'temporarily_unavailable', 'unsafe', 'unknown')),
	CONSTRAINT "game_official_links_method_check" CHECK("__new_game_official_links"."verification_method" is null or "__new_game_official_links"."verification_method" in ('manual', 'http', 'provider_api')),
	CONSTRAINT "game_official_links_http_status_check" CHECK("__new_game_official_links"."http_status" is null or "__new_game_official_links"."http_status" between 100 and 599)
);
--> statement-breakpoint
INSERT INTO `__new_game_official_links`("id", "game_id", "provider", "platform", "link_type", "url", "region", "is_official", "verification_status", "verification_method", "http_status", "redirect_url", "verified_at", "last_checked_at", "created_at", "updated_at") SELECT "id", "game_id", "provider", "platform", "link_type", "url", "region", "is_official", "verification_status", "verification_method", "http_status", "redirect_url", "verified_at", "last_checked_at", "created_at", "updated_at" FROM `game_official_links`;--> statement-breakpoint
DROP TABLE `game_official_links`;--> statement-breakpoint
ALTER TABLE `__new_game_official_links` RENAME TO `game_official_links`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `game_official_links_game_id_url_unique` ON `game_official_links` (`game_id`,`url`);--> statement-breakpoint
CREATE INDEX `game_official_links_game_id_type_idx` ON `game_official_links` (`game_id`,`link_type`);--> statement-breakpoint
CREATE INDEX `game_official_links_verification_idx` ON `game_official_links` (`verification_status`,`last_checked_at`);

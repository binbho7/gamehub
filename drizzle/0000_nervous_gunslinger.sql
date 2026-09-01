CREATE TABLE `companies` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`website_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `companies_slug_unique` ON `companies` (`slug`);--> statement-breakpoint
CREATE INDEX `companies_name_idx` ON `companies` (`name`);--> statement-breakpoint
CREATE TABLE `game_companies` (
	`game_id` integer NOT NULL,
	`company_id` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`game_id`, `company_id`, `role`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_companies_role_check" CHECK("game_companies"."role" in ('developer', 'publisher', 'porting', 'support'))
);
--> statement-breakpoint
CREATE INDEX `game_companies_company_role_idx` ON `game_companies` (`company_id`,`role`,`game_id`);--> statement-breakpoint
CREATE TABLE `game_external_ids` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`external_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_external_ids_provider_external_id_unique` ON `game_external_ids` (`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `game_external_ids_game_id_idx` ON `game_external_ids` (`game_id`);--> statement-breakpoint
CREATE TABLE `game_genres` (
	`game_id` integer NOT NULL,
	`genre_id` integer NOT NULL,
	PRIMARY KEY(`game_id`, `genre_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_genres_genre_id_idx` ON `game_genres` (`genre_id`,`game_id`);--> statement-breakpoint
CREATE TABLE `game_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`type` text NOT NULL,
	`source_url` text NOT NULL,
	`storage_url` text,
	`width` integer,
	`height` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_images_type_check" CHECK("game_images"."type" in ('cover', 'hero', 'screenshot', 'artwork', 'logo')),
	CONSTRAINT "game_images_width_check" CHECK("game_images"."width" is null or "game_images"."width" > 0),
	CONSTRAINT "game_images_height_check" CHECK("game_images"."height" is null or "game_images"."height" > 0),
	CONSTRAINT "game_images_sort_order_check" CHECK("game_images"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE INDEX `game_images_game_order_idx` ON `game_images` (`game_id`,`type`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `game_official_links` (
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
	CONSTRAINT "game_official_links_type_check" CHECK("game_official_links"."link_type" in ('official_website', 'store', 'purchase', 'download', 'demo', 'launcher')),
	CONSTRAINT "game_official_links_status_check" CHECK("game_official_links"."verification_status" in ('unverified', 'pending', 'verified', 'failed')),
	CONSTRAINT "game_official_links_method_check" CHECK("game_official_links"."verification_method" is null or "game_official_links"."verification_method" in ('manual', 'http', 'provider_api')),
	CONSTRAINT "game_official_links_http_status_check" CHECK("game_official_links"."http_status" is null or "game_official_links"."http_status" between 100 and 599)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_official_links_game_id_url_unique` ON `game_official_links` (`game_id`,`url`);--> statement-breakpoint
CREATE INDEX `game_official_links_game_id_type_idx` ON `game_official_links` (`game_id`,`link_type`);--> statement-breakpoint
CREATE INDEX `game_official_links_verification_idx` ON `game_official_links` (`verification_status`,`last_checked_at`);--> statement-breakpoint
CREATE TABLE `game_platforms` (
	`game_id` integer NOT NULL,
	`platform_id` integer NOT NULL,
	PRIMARY KEY(`game_id`, `platform_id`),
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `game_platforms_platform_id_idx` ON `game_platforms` (`platform_id`,`game_id`);--> statement-breakpoint
CREATE TABLE `game_videos` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text,
	`thumbnail_url` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_videos_sort_order_check" CHECK("game_videos"."sort_order" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_videos_game_provider_external_id_unique` ON `game_videos` (`game_id`,`provider`,`external_id`);--> statement-breakpoint
CREATE INDEX `game_videos_game_order_idx` ON `game_videos` (`game_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`description` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`release_date` text,
	`cover_url` text,
	`hero_url` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	CONSTRAINT "games_status_check" CHECK("games"."status" in ('unknown', 'announced', 'upcoming', 'early_access', 'released', 'cancelled', 'delisted')),
	CONSTRAINT "games_release_date_check" CHECK("games"."release_date" is null or "games"."release_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_slug_unique` ON `games` (`slug`);--> statement-breakpoint
CREATE INDEX `games_status_release_date_idx` ON `games` (`status`,`release_date`,`id`);--> statement-breakpoint
CREATE INDEX `games_release_date_idx` ON `games` (`release_date`,`id`);--> statement-breakpoint
CREATE TABLE `genres` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `genres_slug_unique` ON `genres` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `genres_name_unique` ON `genres` (`name`);--> statement-breakpoint
CREATE TABLE `platforms` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platforms_slug_unique` ON `platforms` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `platforms_name_unique` ON `platforms` (`name`);
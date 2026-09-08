PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_game_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`type` text NOT NULL,
	`source_url` text NOT NULL,
	`source_provider` text,
	`storage_url` text,
	`storage_key` text,
	`content_hash` text,
	`mime_type` text,
	`file_size` integer,
	`width` integer,
	`height` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "game_images_type_check" CHECK("__new_game_images"."type" in ('cover', 'hero', 'screenshot', 'artwork', 'logo')),
	CONSTRAINT "game_images_source_provider_check" CHECK("__new_game_images"."source_provider" is null or "__new_game_images"."source_provider" in ('steam', 'igdb')),
	CONSTRAINT "game_images_storage_check" CHECK((
    "__new_game_images"."storage_url" is null
    and "__new_game_images"."storage_key" is null
    and "__new_game_images"."content_hash" is null
    and "__new_game_images"."mime_type" is null
    and "__new_game_images"."file_size" is null
  ) or (
    "__new_game_images"."storage_url" is not null
    and "__new_game_images"."storage_key" is not null
    and "__new_game_images"."content_hash" is not null
    and "__new_game_images"."mime_type" is not null
    and "__new_game_images"."file_size" is not null
  )),
	CONSTRAINT "game_images_storage_size_check" CHECK("__new_game_images"."file_size" is null or "__new_game_images"."file_size" > 0),
	CONSTRAINT "game_images_storage_mime_check" CHECK("__new_game_images"."mime_type" is null or "__new_game_images"."mime_type" in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "game_images_storage_hash_check" CHECK("__new_game_images"."content_hash" is null or ("__new_game_images"."content_hash" glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')),
	CONSTRAINT "game_images_width_check" CHECK("__new_game_images"."width" is null or "__new_game_images"."width" > 0),
	CONSTRAINT "game_images_height_check" CHECK("__new_game_images"."height" is null or "__new_game_images"."height" > 0),
	CONSTRAINT "game_images_sort_order_check" CHECK("__new_game_images"."sort_order" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_game_images`("id", "game_id", "type", "source_url", "source_provider", "storage_url", "storage_key", "content_hash", "mime_type", "file_size", "width", "height", "sort_order", "created_at", "updated_at") SELECT "id", "game_id", "type", "source_url", NULL, "storage_url", NULL, NULL, NULL, NULL, "width", "height", "sort_order", "created_at", "created_at" FROM `game_images`;--> statement-breakpoint
DROP TABLE `game_images`;--> statement-breakpoint
ALTER TABLE `__new_game_images` RENAME TO `game_images`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE INDEX `game_images_game_order_idx` ON `game_images` (`game_id`,`type`,`sort_order`,`id`);--> statement-breakpoint
CREATE INDEX `game_images_game_sort_order_idx` ON `game_images` (`game_id`,`sort_order`,`id`);

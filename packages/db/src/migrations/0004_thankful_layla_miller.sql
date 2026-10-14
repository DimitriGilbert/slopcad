CREATE TABLE `share_link` (
	`id` text PRIMARY KEY NOT NULL,
	`created_by` text,
	`native_content` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `share_link_createdBy_idx` ON `share_link` (`created_by`);
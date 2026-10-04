CREATE TABLE `agent_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agent_conversations_userId_idx` ON `agent_conversations` (`user_id`);--> statement-breakpoint
CREATE INDEX `agent_conversations_projectId_idx` ON `agent_conversations` (`project_id`);--> statement-breakpoint
CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `agent_conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_messages_conversationId_idx` ON `agent_messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `model_catalog_entries` (
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`name` text NOT NULL,
	`release_date` text NOT NULL,
	`vision` integer NOT NULL,
	`context_limit` integer,
	`reasoning_options` text,
	`deprecated` integer NOT NULL,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`provider`, `model_id`)
);
--> statement-breakpoint
CREATE TABLE `model_catalog_meta` (
	`provider` text PRIMARY KEY NOT NULL,
	`etag` text,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_options` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_options_userId_name_uidx` ON `user_options` (`user_id`,`name`);
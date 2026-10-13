CREATE TABLE `simulation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`document_version_id` text NOT NULL,
	`scenario_snapshot_hash` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`histories` text NOT NULL,
	`payload` blob NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`document_version_id`) REFERENCES `document_version`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `simulation_run_documentVersionId_idx` ON `simulation_run` (`document_version_id`);--> statement-breakpoint
CREATE INDEX `simulation_run_scenarioSnapshotHash_idx` ON `simulation_run` (`scenario_snapshot_hash`);
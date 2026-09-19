CREATE TABLE `app_meta` (
	`id` integer PRIMARY KEY NOT NULL,
	`data_generation` integer DEFAULT 1 NOT NULL,
	`last_reset_at` integer
);
--> statement-breakpoint
ALTER TABLE `tutoring_session` ADD `mode` text DEFAULT 'teach' NOT NULL;--> statement-breakpoint
ALTER TABLE `tutoring_session` ADD `resumed_reason` text;
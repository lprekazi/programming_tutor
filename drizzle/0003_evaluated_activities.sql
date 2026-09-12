CREATE TABLE `activity_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`response` text NOT NULL,
	`outcome` text NOT NULL,
	`correct` integer,
	`partial` integer DEFAULT false NOT NULL,
	`marking_source` text,
	`unmarked_reason` text,
	`misconceptions` text NOT NULL,
	`hint_depth` integer DEFAULT 0 NOT NULL,
	`feedback` text NOT NULL,
	`attempted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `session_activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_attempt_unique_activity` ON `activity_attempt` (`activity_id`);--> statement-breakpoint
CREATE TABLE `activity_hint` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`depth` integer NOT NULL,
	`text` text NOT NULL,
	`strategy_id` text,
	`strategy_version` text,
	`model` text,
	`asked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `session_activity`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_hint_unique_depth` ON `activity_hint` (`activity_id`,`depth`);--> statement-breakpoint
CREATE TABLE `session_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`kind` text NOT NULL,
	`item_id` text,
	`origin` text NOT NULL,
	`prompt` text NOT NULL,
	`code` text,
	`options` text,
	`correct_index` integer,
	`option_misconceptions` text,
	`expected_output` text,
	`known_wrong_answers` text,
	`expected_points` text,
	`explanation` text NOT NULL,
	`selection_ground` text NOT NULL,
	`probes_misconception` text,
	`strategy_id` text,
	`strategy_version` text,
	`model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `tutoring_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_activity_unique_turn` ON `session_activity` (`turn_id`);
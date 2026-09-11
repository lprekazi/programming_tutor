CREATE TABLE `concept_state` (
	`learner_id` integer NOT NULL,
	`concept_id` text NOT NULL,
	`theta` real NOT NULL,
	`uncertainty` real NOT NULL,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`successes` integer DEFAULT 0 NOT NULL,
	`unaided_successes` integer DEFAULT 0 NOT NULL,
	`support_signal` real DEFAULT 0 NOT NULL,
	`last_seen_at` integer,
	`next_review_at` integer,
	PRIMARY KEY(`learner_id`, `concept_id`),
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `diagnostic_response` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`item_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`answer` text NOT NULL,
	`correct` integer NOT NULL,
	`verdict_source` text NOT NULL,
	`execution_output` text,
	`failed_tests` text,
	`answered_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `diagnostic_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `diagnostic_response_unique_item` ON `diagnostic_response` (`session_id`,`item_id`);--> statement-breakpoint
CREATE TABLE `diagnostic_session` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`completed_at` integer,
	`completion_reason` text,
	`skipped_items` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`concept_id` text NOT NULL,
	`source` text NOT NULL,
	`attempt_id` text NOT NULL,
	`correct` integer NOT NULL,
	`hint_depth` integer DEFAULT 0 NOT NULL,
	`prior_theta` real NOT NULL,
	`posterior_theta` real NOT NULL,
	`prior_band` text NOT NULL,
	`posterior_band` text NOT NULL,
	`reason` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `evidence_by_concept` ON `evidence` (`learner_id`,`concept_id`);--> statement-breakpoint
CREATE TABLE `item_calibration_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`item_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`declared_difficulty` real NOT NULL,
	`theta_at_attempt` real NOT NULL,
	`expected` real NOT NULL,
	`correct` integer NOT NULL,
	`residual` real NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `misconception_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`attempt_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`misconception_id` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `self_report` (
	`learner_id` integer NOT NULL,
	`area` text NOT NULL,
	`confidence` text NOT NULL,
	`recorded_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`learner_id`, `area`),
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `learner` ADD `goal` text;--> statement-breakpoint
ALTER TABLE `learner` ADD `experience` text;--> statement-breakpoint
ALTER TABLE `learner` ADD `interests` text;--> statement-breakpoint
ALTER TABLE `learner` ADD `onboarding_step` text DEFAULT 'goal' NOT NULL;--> statement-breakpoint
ALTER TABLE `learner` ADD `onboarding_completed_at` integer;--> statement-breakpoint
ALTER TABLE `learner` ADD `diagnostic_completed_at` integer;
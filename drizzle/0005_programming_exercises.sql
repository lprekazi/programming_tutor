CREATE TABLE `exercise_generation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`strategy_version` text,
	`model` text,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`exercise_id`) REFERENCES `session_exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `exercise_hint` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`depth` integer NOT NULL,
	`text` text NOT NULL,
	`source` text NOT NULL,
	`strategy_id` text,
	`strategy_version` text,
	`model` text,
	`asked_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`exercise_id`) REFERENCES `session_exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_hint_unique_depth` ON `exercise_hint` (`exercise_id`,`depth`);--> statement-breakpoint
CREATE TABLE `exercise_submission` (
	`id` text PRIMARY KEY NOT NULL,
	`exercise_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`code` text NOT NULL,
	`code_hash` text NOT NULL,
	`outcome` text NOT NULL,
	`state` text NOT NULL,
	`passed_checks` integer,
	`total_checks` integer NOT NULL,
	`unmarked_reason` text,
	`misconceptions` text NOT NULL,
	`hints_taken` integer NOT NULL,
	`counted` integer NOT NULL,
	`feedback_status` text NOT NULL,
	`feedback` text,
	`feedback_strategy_id` text,
	`feedback_strategy_version` text,
	`feedback_model` text,
	`submitted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`exercise_id`) REFERENCES `session_exercise`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_submission_unique_code` ON `exercise_submission` (`exercise_id`,`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `exercise_submission_unique_ordinal` ON `exercise_submission` (`exercise_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `session_exercise` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`concept_id` text NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`exercise_id` text,
	`bank_version` text,
	`title` text NOT NULL,
	`brief` text NOT NULL,
	`starter_code` text NOT NULL,
	`tests` text NOT NULL,
	`reference_solution` text NOT NULL,
	`signals` text NOT NULL,
	`authored_hints` text,
	`difficulty` real NOT NULL,
	`selection_ground` text NOT NULL,
	`verification` text NOT NULL,
	`generation_attempt` integer DEFAULT 0 NOT NULL,
	`strategy_id` text,
	`strategy_version` text,
	`model` text,
	`draft_code` text,
	`draft_edited_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `tutoring_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_exercise_unique_turn` ON `session_exercise` (`turn_id`);
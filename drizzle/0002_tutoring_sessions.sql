CREATE TABLE `llm_call` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`strategy_id` text NOT NULL,
	`strategy_version` text NOT NULL,
	`policy_version` text NOT NULL,
	`curriculum_version` text NOT NULL,
	`model` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`repair_attempted` integer NOT NULL,
	`repair_succeeded` integer NOT NULL,
	`problem_codes` text NOT NULL,
	`failure_reason` text,
	`input_tokens` integer,
	`cached_input_tokens` integer,
	`output_tokens` integer,
	`streamed` integer NOT NULL,
	`at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `llm_call_by_time` ON `llm_call` (`learner_id`,`at`);--> statement-breakpoint
CREATE TABLE `session_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`concepts_discussed` text NOT NULL,
	`misconceptions` text NOT NULL,
	`note` text NOT NULL,
	`observed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `tutoring_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session_turn` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`role` text NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`strategy_id` text,
	`strategy_version` text,
	`model` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `tutoring_session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_turn_unique_ordinal` ON `session_turn` (`session_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `tutoring_session` (
	`id` text PRIMARY KEY NOT NULL,
	`learner_id` integer NOT NULL,
	`concept_id` text NOT NULL,
	`opened_reason` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`learner_id`) REFERENCES `learner`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tutoring_session_unique_concept` ON `tutoring_session` (`learner_id`,`concept_id`);
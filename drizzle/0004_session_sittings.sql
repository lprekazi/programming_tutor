ALTER TABLE `tutoring_session` ADD `resumed_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Existing sessions have been sat with at least once, and the only honest marker for when that
-- was is when they were started. Without this they would date from 1970 and every check ever
-- asked in them would count towards the current sitting, which is the defect this column fixes.
UPDATE `tutoring_session` SET `resumed_at` = `started_at`;

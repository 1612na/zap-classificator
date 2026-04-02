CREATE TABLE `classification_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`intent` text,
	`sentiment` text,
	`priority` integer DEFAULT 3,
	`summary` text,
	`next_action` text,
	`classified_by` text NOT NULL,
	`model_version` text,
	`classified_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `classifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text NOT NULL,
	`intent` text,
	`sentiment` text,
	`priority` integer DEFAULT 3,
	`summary` text,
	`next_action` text,
	`classified_by` text NOT NULL,
	`model_version` text,
	`classified_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `classifications_conversation_id_unique` ON `classifications` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `classifications_status_idx` ON `classifications` (`status`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`display_name` text,
	`is_business` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`name` text,
	`is_group` integer DEFAULT 0,
	`last_message_at` integer,
	`unread_count` integer DEFAULT 0,
	`is_archived` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_last_message_at_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`from_me` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`text` text,
	`message_type` text NOT NULL,
	`raw_payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_chat_id_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_type` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`conversations_processed` integer DEFAULT 0,
	`messages_ingested` integer DEFAULT 0,
	`classifications_updated` integer DEFAULT 0,
	`error` text,
	`status` text DEFAULT 'running'
);

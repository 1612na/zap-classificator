CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`push_name` text,
	`display_name` text,
	`is_business` integer DEFAULT 0,
	`avatar_url` text,
	`about` text,
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversations_last_message_at_idx` ON `conversations` (`last_message_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_id` text NOT NULL,
	`sender_jid` text,
	`from_me` integer NOT NULL,
	`timestamp` integer NOT NULL,
	`text` text,
	`message_type` text NOT NULL,
	`has_media` integer DEFAULT 0,
	`media_url` text,
	`media_mime` text,
	`is_forwarded` integer DEFAULT 0,
	`quoted_message_id` text,
	`raw_payload` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_chat_id_idx` ON `messages` (`chat_id`);--> statement-breakpoint
CREATE INDEX `messages_timestamp_idx` ON `messages` (`timestamp`);--> statement-breakpoint
CREATE TABLE `push_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `push_queue_status_idx` ON `push_queue` (`status`);--> statement-breakpoint
CREATE INDEX `push_queue_next_attempt_idx` ON `push_queue` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_type` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`conversations_processed` integer DEFAULT 0,
	`messages_ingested` integer DEFAULT 0,
	`error` text,
	`status` text DEFAULT 'running'
);

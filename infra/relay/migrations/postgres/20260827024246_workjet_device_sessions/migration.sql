CREATE TABLE "relay_workjet_business_os_environments" (
	"business_os_instance_id" varchar(512),
	"environment_id" varchar(191),
	"created_at" varchar(64) NOT NULL,
	CONSTRAINT "relay_workjet_business_os_environments_pkey" PRIMARY KEY("business_os_instance_id","environment_id")
);
--> statement-breakpoint
CREATE TABLE "relay_workjet_business_os_instances" (
	"business_os_instance_id" varchar(512) PRIMARY KEY,
	"relay_user_id" varchar(191) NOT NULL,
	"membership_version" integer DEFAULT 0 NOT NULL,
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workjet_control_identity_assertions" (
	"jti" varchar(128) PRIMARY KEY,
	"relay_user_id" varchar(191) NOT NULL,
	"workjet_installation_id" varchar(256) NOT NULL,
	"business_os_instance_id" varchar(512) NOT NULL,
	"proof_key_thumbprint" varchar(128) NOT NULL,
	"expires_at" varchar(64) NOT NULL,
	"consumed_at" varchar(64),
	"created_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_workjet_device_session_grants" (
	"grant_id" varchar(128) PRIMARY KEY,
	"device_pairing_id" varchar(1024) NOT NULL,
	"business_os_instance_id" varchar(512) NOT NULL,
	"relay_user_id" varchar(191) NOT NULL,
	"device_id" varchar(512) NOT NULL,
	"proof_key_thumbprint" varchar(128) NOT NULL,
	"bootstrap_credential_hash" varchar(64) NOT NULL,
	"bootstrap_expires_at" varchar(64) NOT NULL,
	"bootstrap_consumed_at" varchar(64),
	"refresh_grant_hash" varchar(64),
	"refresh_expires_at" varchar(64),
	"access_generation" integer DEFAULT 0 NOT NULL,
	"revoked_at" varchar(64),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_workjet_business_os_environments_environment" ON "relay_workjet_business_os_environments" ("environment_id","business_os_instance_id");--> statement-breakpoint
CREATE INDEX "idx_relay_workjet_business_os_instances_user" ON "relay_workjet_business_os_instances" ("relay_user_id","business_os_instance_id");--> statement-breakpoint
CREATE INDEX "idx_relay_workjet_control_identity_assertions_expiry" ON "relay_workjet_control_identity_assertions" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_workjet_device_session_grants_pairing" ON "relay_workjet_device_session_grants" ("device_pairing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_workjet_device_session_grants_bootstrap" ON "relay_workjet_device_session_grants" ("bootstrap_credential_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_relay_workjet_device_session_grants_refresh" ON "relay_workjet_device_session_grants" ("refresh_grant_hash");--> statement-breakpoint
CREATE INDEX "idx_relay_workjet_device_session_grants_instance" ON "relay_workjet_device_session_grants" ("business_os_instance_id","revoked_at");
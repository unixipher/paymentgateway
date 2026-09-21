-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "google_sub" TEXT,
    "gmail_refresh_token" TEXT,
    "gmail_connected_at" DATETIME,
    "vpa" TEXT,
    "bank_key" TEXT,
    "display_name" TEXT,
    "confirm_by_email" BOOLEAN NOT NULL DEFAULT true,
    "confirm_by_sms" BOOLEAN NOT NULL DEFAULT true,
    "webhook_url" TEXT,
    "webhook_secret" TEXT NOT NULL,
    "api_key_hash" TEXT,
    "api_key_prefix" TEXT,
    "api_key_created_at" DATETIME,
    "last_polled_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "sessions_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "login_codes" (
    "code_hash" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "redirect_path" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "login_codes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "base_paise" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "note" TEXT,
    "redirect_url" TEXT,
    "metadata" JSONB,
    "idempotency_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "claimed_utr" TEXT,
    "payer_name" TEXT,
    "failure_notified_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    "opened_at" DATETIME,
    "paid_at" DATETIME,
    "cancelled_at" DATETIME,
    CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bank_txns" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "message_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "utr" TEXT,
    "payer_vpa" TEXT,
    "payer_name" TEXT,
    "bank_domain" TEXT NOT NULL,
    "received_at" DATETIME NOT NULL,
    "email_confirmed_at" DATETIME,
    "unverified_notified_at" DATETIME,
    "order_id" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bank_txns_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "bank_txns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "failed_payments" (
    "merchant_id" TEXT NOT NULL,
    "utr" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "amount_paise" INTEGER,
    "received_at" DATETIME NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("merchant_id", "utr"),
    CONSTRAINT "failed_payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "gmail_messages" (
    "merchant_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "received_at" DATETIME NOT NULL,
    "from_addr" TEXT,
    "subject" TEXT,
    "verdict" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("merchant_id", "gmail_message_id"),
    CONSTRAINT "gmail_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "token_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME,
    CONSTRAINT "devices_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "device_pairing_codes" (
    "code_hash" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME NOT NULL,
    CONSTRAINT "device_pairing_codes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "device_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "device_id" TEXT,
    "channel" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "received_at" DATETIME NOT NULL,
    "delivered_at" DATETIME,
    "verdict" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "device_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_messages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "merchant_id" TEXT NOT NULL,
    "order_id" TEXT,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" DATETIME,
    "last_status_code" INTEGER,
    "last_error" TEXT,
    "delivered_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_deliveries_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "webhook_deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "window_start" DATETIME NOT NULL,
    "count" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_email_key" ON "merchants"("email");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_google_sub_key" ON "merchants"("google_sub");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_api_key_hash_key" ON "merchants"("api_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_merchant_id_idx" ON "sessions"("merchant_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE INDEX "login_codes_expires_at_idx" ON "login_codes"("expires_at");

-- CreateIndex
CREATE INDEX "orders_merchant_id_status_amount_paise_idx" ON "orders"("merchant_id", "status", "amount_paise");

-- CreateIndex
CREATE INDEX "orders_merchant_id_claimed_utr_idx" ON "orders"("merchant_id", "claimed_utr");

-- CreateIndex
CREATE INDEX "orders_merchant_id_created_at_idx" ON "orders"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "orders_merchant_id_idempotency_key_key" ON "orders"("merchant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_order_id_key" ON "bank_txns"("order_id");

-- CreateIndex
CREATE INDEX "bank_txns_email_confirmed_at_received_at_idx" ON "bank_txns"("email_confirmed_at", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_merchant_id_message_id_key" ON "bank_txns"("merchant_id", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_merchant_id_utr_key" ON "bank_txns"("merchant_id", "utr");

-- CreateIndex
CREATE INDEX "gmail_messages_merchant_id_received_at_idx" ON "gmail_messages"("merchant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "devices_token_hash_key" ON "devices"("token_hash");

-- CreateIndex
CREATE INDEX "devices_merchant_id_idx" ON "devices"("merchant_id");

-- CreateIndex
CREATE INDEX "device_pairing_codes_expires_at_idx" ON "device_pairing_codes"("expires_at");

-- CreateIndex
CREATE INDEX "device_messages_merchant_id_received_at_idx" ON "device_messages"("merchant_id", "received_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_merchant_id_created_at_idx" ON "webhook_deliveries"("merchant_id", "created_at");

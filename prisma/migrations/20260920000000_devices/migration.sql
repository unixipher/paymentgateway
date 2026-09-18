-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('email', 'sms', 'notification');

-- Bank credits and failed payments can now come from a phone as well as Gmail.
ALTER TABLE "bank_txns" RENAME COLUMN "gmail_message_id" TO "message_id";
ALTER TABLE "bank_txns" ADD COLUMN "channel" "Channel" NOT NULL DEFAULT 'email';
ALTER INDEX "bank_txns_merchant_id_gmail_message_id_key" RENAME TO "bank_txns_merchant_id_message_id_key";
ALTER TABLE "failed_payments" RENAME COLUMN "gmail_message_id" TO "message_id";

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "app_version" TEXT,
    "token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_pairing_codes" (
    "code_hash" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pairing_codes_pkey" PRIMARY KEY ("code_hash")
);

-- CreateTable
CREATE TABLE "device_messages" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "device_id" TEXT,
    "channel" "Channel" NOT NULL,
    "sender" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "verdict" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_token_hash_key" ON "devices"("token_hash");
CREATE INDEX "devices_merchant_id_idx" ON "devices"("merchant_id");
CREATE INDEX "device_pairing_codes_expires_at_idx" ON "device_pairing_codes"("expires_at");
CREATE INDEX "device_messages_merchant_id_received_at_idx" ON "device_messages"("merchant_id", "received_at");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_pairing_codes" ADD CONSTRAINT "device_pairing_codes_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_messages" ADD CONSTRAINT "device_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "device_messages" ADD CONSTRAINT "device_messages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

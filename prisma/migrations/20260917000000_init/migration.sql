-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('pending', 'paid');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "refresh_token" TEXT,
    "vpa" TEXT,
    "display_name" TEXT,
    "webhook_url" TEXT,
    "webhook_secret" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "base_paise" INTEGER NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "note" TEXT,
    "redirect_url" TEXT,
    "status" "OrderStatus" NOT NULL DEFAULT 'pending',
    "claimed_utr" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_txns" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "utr" TEXT,
    "payer_vpa" TEXT,
    "bank_domain" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "order_id" TEXT,

    CONSTRAINT "bank_txns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gmail_messages" (
    "merchant_id" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "from_addr" TEXT,
    "subject" TEXT,
    "verdict" TEXT NOT NULL,

    CONSTRAINT "gmail_messages_pkey" PRIMARY KEY ("merchant_id","gmail_message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_email_key" ON "merchants"("email");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_api_key_key" ON "merchants"("api_key");

-- CreateIndex
CREATE INDEX "orders_merchant_id_status_amount_paise_idx" ON "orders"("merchant_id", "status", "amount_paise");

-- CreateIndex
CREATE INDEX "orders_merchant_id_claimed_utr_idx" ON "orders"("merchant_id", "claimed_utr");

-- CreateIndex
CREATE INDEX "orders_merchant_id_created_at_idx" ON "orders"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_order_id_key" ON "bank_txns"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_merchant_id_gmail_message_id_key" ON "bank_txns"("merchant_id", "gmail_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_txns_merchant_id_utr_key" ON "bank_txns"("merchant_id", "utr");

-- CreateIndex
CREATE INDEX "gmail_messages_merchant_id_received_at_idx" ON "gmail_messages"("merchant_id", "received_at");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_txns" ADD CONSTRAINT "bank_txns_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_txns" ADD CONSTRAINT "bank_txns_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


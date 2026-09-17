-- AlterTable
ALTER TABLE "orders" ADD COLUMN "failure_notified_at" TIMESTAMP(3);

-- Orders that expired before this migration were already final; don't send order.failed for them.
UPDATE "orders" SET "failure_notified_at" = CURRENT_TIMESTAMP WHERE "status" = 'pending' AND "expires_at" < CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "failed_payments" (
    "merchant_id" TEXT NOT NULL,
    "utr" TEXT NOT NULL,
    "gmail_message_id" TEXT NOT NULL,
    "amount_paise" INTEGER,
    "received_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_payments_pkey" PRIMARY KEY ("merchant_id","utr")
);

-- CreateIndex
CREATE INDEX "orders_status_expires_at_idx" ON "orders"("status", "expires_at");

-- AddForeignKey
ALTER TABLE "failed_payments" ADD CONSTRAINT "failed_payments_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

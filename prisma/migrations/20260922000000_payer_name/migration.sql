-- AlterTable
ALTER TABLE "orders" ADD COLUMN "payer_name" TEXT;

-- AlterTable
ALTER TABLE "bank_txns" ADD COLUMN "payer_name" TEXT;

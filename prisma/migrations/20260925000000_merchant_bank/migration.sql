-- AlterTable
-- The bank the merchant's UPI ID pays into, so an alert from any other bank can be refused.
-- Null means they have not said, and alerts from any bank are accepted as before.
ALTER TABLE "merchants" ADD COLUMN "bank_key" TEXT;

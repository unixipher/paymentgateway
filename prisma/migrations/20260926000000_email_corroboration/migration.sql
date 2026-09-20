-- AlterTable
-- When a DKIM/DMARC-verified bank email corroborated this credit. A phone can forge an SMS; it
-- cannot forge the bank's email, so a credit no email ever confirms is worth flagging.
ALTER TABLE "bank_txns" ADD COLUMN "email_confirmed_at" TIMESTAMP(3);
ALTER TABLE "bank_txns" ADD COLUMN "unverified_notified_at" TIMESTAMP(3);

-- Credits recorded before this change: the ones that came by email were confirmed by it.
UPDATE "bank_txns" SET "email_confirmed_at" = "received_at" WHERE "channel" = 'email';

-- Drives the sweep for credits still waiting on an email.
CREATE INDEX "bank_txns_email_confirmed_at_received_at_idx"
  ON "bank_txns" ("email_confirmed_at", "received_at");

-- Credits a phone reported before this change were never checked against the bank's email, and
-- cannot be now. Mark them as already notified so the first sweep flags only new payments instead
-- of raising payment.unverified for every settled order in the merchant's history.
UPDATE "bank_txns" SET "unverified_notified_at" = now() WHERE "channel" <> 'email';

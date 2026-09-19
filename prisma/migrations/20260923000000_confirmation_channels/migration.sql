-- Which bank alerts may mark orders paid. Both stay on for existing merchants.
ALTER TABLE "merchants" ADD COLUMN "confirm_by_email" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "merchants" ADD COLUMN "confirm_by_sms" BOOLEAN NOT NULL DEFAULT true;

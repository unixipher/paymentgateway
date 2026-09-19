-- AlterTable
ALTER TABLE "orders" ADD COLUMN "opened_at" TIMESTAMP(3);

-- Orders created before this change started their timer when they were created.
UPDATE "orders" SET "opened_at" = "created_at";

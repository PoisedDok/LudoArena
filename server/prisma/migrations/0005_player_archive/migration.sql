ALTER TABLE "User"
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ADD COLUMN "permanentlyPurgedAt" TIMESTAMP(3);

CREATE INDEX "User_deletedAt_role_idx" ON "User"("deletedAt", "role");

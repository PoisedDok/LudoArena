DROP INDEX "User_username_key";

CREATE UNIQUE INDEX "User_username_active_key"
    ON "User" (lower("username"))
    WHERE "permanentlyPurgedAt" IS NULL;

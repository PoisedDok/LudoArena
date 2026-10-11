-- Money becomes NUMERIC(12,2); existing float values are rounded to the cent by the cast.
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "balance" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "creditLimit" SET DATA TYPE DECIMAL(12,2),
ALTER COLUMN "spendLimit" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "Ping" ALTER COLUMN "stake" SET DATA TYPE DECIMAL(12,2);

-- The undo window of an agreed result is stored, so a restart cannot lose a pending settlement.
ALTER TABLE "Game" ADD COLUMN "settleSecondPlaceId" TEXT,
ADD COLUMN "settleWinnerId" TEXT,
ADD COLUMN "settlesAt" TIMESTAMP(3),
ALTER COLUMN "stake" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "Transaction" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

ALTER TABLE "DepositRequest" ADD COLUMN "screenshotHash" TEXT,
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(12,2);

CREATE TABLE "IdempotencyKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");
CREATE UNIQUE INDEX "IdempotencyKey_userId_key_key" ON "IdempotencyKey"("userId", "key");
CREATE INDEX "Ping_status_expiresAt_idx" ON "Ping"("status", "expiresAt");
CREATE INDEX "Ping_fromUserId_idx" ON "Ping"("fromUserId");
CREATE INDEX "PingRecipient_userId_idx" ON "PingRecipient"("userId");
CREATE INDEX "Game_status_settlesAt_idx" ON "Game"("status", "settlesAt");
CREATE INDEX "Game_status_createdAt_idx" ON "Game"("status", "createdAt");
CREATE INDEX "Game_createdAt_idx" ON "Game"("createdAt");
CREATE INDEX "GamePlayer_userId_idx" ON "GamePlayer"("userId");
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt");
CREATE INDEX "Transaction_gameId_idx" ON "Transaction"("gameId");
CREATE INDEX "Transaction_type_createdAt_idx" ON "Transaction"("type", "createdAt");
CREATE INDEX "Screenshot_gameId_idx" ON "Screenshot"("gameId");
CREATE UNIQUE INDEX "DepositRequest_screenshotHash_key" ON "DepositRequest"("screenshotHash");
CREATE INDEX "DepositRequest_userId_createdAt_idx" ON "DepositRequest"("userId", "createdAt");
CREATE INDEX "DepositRequest_status_createdAt_idx" ON "DepositRequest"("status", "createdAt");

-- Rules the application also enforces; the database refuses what a bug would otherwise store.
ALTER TABLE "User" ADD CONSTRAINT "User_limits_nonnegative" CHECK ("creditLimit" >= 0 AND "spendLimit" >= 0);
ALTER TABLE "Ping" ADD CONSTRAINT "Ping_stake_positive" CHECK ("stake" > 0);
ALTER TABLE "Game" ADD CONSTRAINT "Game_stake_positive" CHECK ("stake" > 0);
ALTER TABLE "DepositRequest" ADD CONSTRAINT "DepositRequest_amount_positive" CHECK ("amount" > 0);

CREATE TABLE "CommissionSetting" (
    "gameType" "GameType" NOT NULL,
    "tierThresholdCents" INTEGER,
    "highRateBps" INTEGER,
    "lowRateBps" INTEGER,
    "fourPlayerSecondBps" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,

    CONSTRAINT "CommissionSetting_pkey" PRIMARY KEY ("gameType")
);

CREATE TABLE "CommissionSettingChange" (
    "id" TEXT NOT NULL,
    "gameType" "GameType" NOT NULL,
    "actorId" TEXT,
    "actorUsername" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionSettingChange_pkey" PRIMARY KEY ("id")
);

INSERT INTO "CommissionSetting" ("gameType", "tierThresholdCents", "highRateBps", "lowRateBps", "fourPlayerSecondBps")
VALUES
    ('ONE_V_ONE', 50000, 500, 300, NULL),
    ('TWO_V_TWO', 50000, 500, 300, NULL),
    ('FOUR_PLAYER', NULL, NULL, NULL, 1000);

ALTER TABLE "Game"
    ADD COLUMN "commissionTierThresholdCents" INTEGER,
    ADD COLUMN "commissionHighRateBps" INTEGER,
    ADD COLUMN "commissionLowRateBps" INTEGER,
    ADD COLUMN "commissionFourPlayerSecondBps" INTEGER;

UPDATE "Game"
SET
    "commissionTierThresholdCents" = CASE WHEN "gameType" IN ('ONE_V_ONE', 'TWO_V_TWO') THEN 50000 ELSE NULL END,
    "commissionHighRateBps" = CASE WHEN "gameType" IN ('ONE_V_ONE', 'TWO_V_TWO') THEN 500 ELSE NULL END,
    "commissionLowRateBps" = CASE WHEN "gameType" IN ('ONE_V_ONE', 'TWO_V_TWO') THEN 300 ELSE NULL END,
    "commissionFourPlayerSecondBps" = CASE WHEN "gameType" = 'FOUR_PLAYER' THEN 1000 ELSE NULL END;

-- Only the fields that apply to the game's type may be populated.
ALTER TABLE "Game"
    ADD CONSTRAINT "Game_commission_snapshot_shape" CHECK (
        (
            "gameType" IN ('ONE_V_ONE', 'TWO_V_TWO')
            AND "commissionTierThresholdCents" IS NOT NULL
            AND "commissionTierThresholdCents" BETWEEN 0 AND 100000000
            AND "commissionHighRateBps" IS NOT NULL
            AND "commissionHighRateBps" BETWEEN 0 AND 10000
            AND "commissionLowRateBps" IS NOT NULL
            AND "commissionLowRateBps" BETWEEN 0 AND 10000
            AND "commissionFourPlayerSecondBps" IS NULL
        )
        OR
        (
            "gameType" = 'FOUR_PLAYER'
            AND "commissionTierThresholdCents" IS NULL
            AND "commissionHighRateBps" IS NULL
            AND "commissionLowRateBps" IS NULL
            AND "commissionFourPlayerSecondBps" IS NOT NULL
            AND "commissionFourPlayerSecondBps" BETWEEN 0 AND 10000
        )
    );

ALTER TABLE "CommissionSetting"
    ADD CONSTRAINT "CommissionSetting_shape" CHECK (
        (
            "gameType" IN ('ONE_V_ONE', 'TWO_V_TWO')
            AND "tierThresholdCents" IS NOT NULL
            AND "tierThresholdCents" BETWEEN 0 AND 100000000
            AND "highRateBps" IS NOT NULL
            AND "highRateBps" BETWEEN 0 AND 10000
            AND "lowRateBps" IS NOT NULL
            AND "lowRateBps" BETWEEN 0 AND 10000
            AND "fourPlayerSecondBps" IS NULL
        )
        OR
        (
            "gameType" = 'FOUR_PLAYER'
            AND "tierThresholdCents" IS NULL
            AND "highRateBps" IS NULL
            AND "lowRateBps" IS NULL
            AND "fourPlayerSecondBps" IS NOT NULL
            AND "fourPlayerSecondBps" BETWEEN 0 AND 10000
        )
    );

CREATE INDEX "CommissionSettingChange_gameType_createdAt_idx" ON "CommissionSettingChange"("gameType", "createdAt");
CREATE INDEX "CommissionSettingChange_actorId_createdAt_idx" ON "CommissionSettingChange"("actorId", "createdAt");

ALTER TABLE "CommissionSetting"
    ADD CONSTRAINT "CommissionSetting_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CommissionSettingChange"
    ADD CONSTRAINT "CommissionSettingChange_gameType_fkey"
    FOREIGN KEY ("gameType") REFERENCES "CommissionSetting"("gameType") ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT "CommissionSettingChange_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

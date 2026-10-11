CREATE TABLE "ShareLoginLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "ShareLoginLink_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ShareLoginLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ShareLoginLink_userId_key" ON "ShareLoginLink"("userId");
CREATE UNIQUE INDEX "ShareLoginLink_tokenHash_key" ON "ShareLoginLink"("tokenHash");
CREATE INDEX "ShareLoginLink_expiresAt_idx" ON "ShareLoginLink"("expiresAt");

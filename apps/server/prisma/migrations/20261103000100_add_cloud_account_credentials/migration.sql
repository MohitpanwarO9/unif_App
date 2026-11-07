-- CreateTable
CREATE TABLE "CloudAccountCredential" (
    "id" TEXT NOT NULL,
    "cloudAccountId" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudAccountCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloudAccountCredential_cloudAccountId_key" ON "CloudAccountCredential"("cloudAccountId");

-- AddForeignKey
ALTER TABLE "CloudAccountCredential" ADD CONSTRAINT "CloudAccountCredential_cloudAccountId_fkey" FOREIGN KEY ("cloudAccountId") REFERENCES "CloudAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;


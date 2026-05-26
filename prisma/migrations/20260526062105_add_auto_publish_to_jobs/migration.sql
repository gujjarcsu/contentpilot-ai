-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GenerationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "completedProducts" INTEGER NOT NULL DEFAULT 0,
    "failedProducts" INTEGER NOT NULL DEFAULT 0,
    "productIds" TEXT NOT NULL DEFAULT '[]',
    "contentTypes" TEXT NOT NULL DEFAULT 'description',
    "autoPublish" BOOLEAN NOT NULL DEFAULT false,
    "errorLog" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GenerationJob" ("completedAt", "completedProducts", "contentTypes", "createdAt", "errorLog", "failedProducts", "id", "productIds", "shop", "startedAt", "status", "totalProducts", "updatedAt") SELECT "completedAt", "completedProducts", "contentTypes", "createdAt", "errorLog", "failedProducts", "id", "productIds", "shop", "startedAt", "status", "totalProducts", "updatedAt" FROM "GenerationJob";
DROP TABLE "GenerationJob";
ALTER TABLE "new_GenerationJob" RENAME TO "GenerationJob";
CREATE INDEX "GenerationJob_shop_status_idx" ON "GenerationJob"("shop", "status");
CREATE INDEX "GenerationJob_shop_createdAt_idx" ON "GenerationJob"("shop", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

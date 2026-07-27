-- CreateTable
CREATE TABLE "Section" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "sourceHtml" TEXT NOT NULL,
    "sourceCss" TEXT,
    "sourceScreenshot" TEXT NOT NULL,
    "generatedCode" TEXT,
    "renderScreenshot" TEXT,
    "diffScore" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "iterations" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Section_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Section_siteId_idx" ON "Section"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Section_siteId_order_key" ON "Section"("siteId", "order");

-- AddForeignKey
ALTER TABLE "Section" ADD CONSTRAINT "Section_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

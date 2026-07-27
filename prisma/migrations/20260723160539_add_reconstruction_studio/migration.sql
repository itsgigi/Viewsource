-- AlterTable
ALTER TABLE "Section" ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "filePath" TEXT,
ADD COLUMN     "prompt" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ALTER COLUMN "sourceHtml" DROP NOT NULL,
ALTER COLUMN "sourceScreenshot" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "reconstructionStatus" TEXT;

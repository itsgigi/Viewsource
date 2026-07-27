-- AlterTable
ALTER TABLE "Section" ADD COLUMN     "annotations" JSONB,
ADD COLUMN     "boundsHeight" INTEGER,
ADD COLUMN     "boundsTop" INTEGER,
ADD COLUMN     "detectedLibs" JSONB,
ADD COLUMN     "filmstrip" JSONB,
ADD COLUMN     "mediaAssets" JSONB,
ADD COLUMN     "motionDescription" TEXT,
ADD COLUMN     "motionHints" JSONB,
ALTER COLUMN "status" SET DEFAULT 'captured';

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "sectionsFullPageScreenshot" TEXT;

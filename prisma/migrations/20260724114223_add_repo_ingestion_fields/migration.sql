-- AlterTable
ALTER TABLE "Component" ADD COLUMN     "bundleFiles" TEXT,
ADD COLUMN     "excluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "filePath" TEXT,
ADD COLUMN     "npmDeps" TEXT,
ADD COLUMN     "previewImage" TEXT,
ADD COLUMN     "propsSchema" TEXT,
ADD COLUMN     "rank" INTEGER;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "branch" TEXT,
ADD COLUMN     "license" TEXT;

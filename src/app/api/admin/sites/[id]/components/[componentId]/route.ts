import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";

const patchSchema = z.object({
  cover: z.string().url().nullable().optional(),
  coverType: z.enum(["image", "video"]).nullable().optional(),
  excluded: z.boolean().optional(), // hides/shows the component in the public grid (Phase 6)
});

// Updates a component's cover (photo/video) from the admin panel
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; componentId: string }> }
) {
  const { id, componentId } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const component = await prisma.component
    .update({
      where: { id: componentId, siteId: id },
      data: parsed.data,
    })
    .catch(() => null);

  if (!component) {
    return NextResponse.json(
      { error: "Component not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(component);
}

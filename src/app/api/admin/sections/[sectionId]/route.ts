import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { restoreIteration } from "@/lib/sections/pipeline";

function serialize(section: { iterations: string | null; [key: string]: unknown }) {
  return {
    ...section,
    iterations: section.iterations ? JSON.parse(section.iterations) : [],
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;

  const section = await prisma.section.findUnique({ where: { id: sectionId } });
  if (!section) {
    return NextResponse.json({ error: "Sezione non trovata" }, { status: 404 });
  }

  return NextResponse.json(serialize(section));
}

const annotationsSchema = z.object({
  mediaType: z.enum(["image", "video", "canvas-webgl", "none"]),
  animations: z.array(
    z.enum([
      "reveal-on-scroll",
      "parallax",
      "content-swap",
      "pin-sticky",
      "hover-effect",
      "custom-cursor",
      "none",
    ])
  ),
  difficulty: z.enum(["easy", "medium", "not-feasible"]),
  notes: z.string().optional(),
});

const patchSchema = z.union([
  z.object({ status: z.enum(["captured", "pending", "generated", "approved", "rejected"]) }),
  z.object({ restoreIterationIndex: z.number().int().min(0) }),
  z.object({ annotations: annotationsSchema }),
  z.object({ motionDescription: z.string() }),
  z.object({ name: z.string().min(1) }),
]);

// Approva/rigetta la sezione, ripristina un'iterazione storica, salva
// l'annotazione strutturata HITL, la motionDescription revisionata, o
// rinomina la sezione.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    if ("restoreIterationIndex" in parsed.data) {
      const section = await restoreIteration(sectionId, parsed.data.restoreIterationIndex);
      return NextResponse.json(serialize(section));
    }

    if ("annotations" in parsed.data) {
      // annotations è colonna Json (non String come `iterations`): Prisma
      // vuole il valore già come oggetto JS, la (de)serializzazione verso
      // jsonb è automatica.
      const section = await prisma.section.update({
        where: { id: sectionId },
        data: { annotations: parsed.data.annotations },
      });
      return NextResponse.json(serialize(section));
    }

    if ("motionDescription" in parsed.data) {
      const section = await prisma.section.update({
        where: { id: sectionId },
        data: { motionDescription: parsed.data.motionDescription },
      });
      return NextResponse.json(serialize(section));
    }

    if ("name" in parsed.data) {
      const section = await prisma.section.update({
        where: { id: sectionId },
        data: { name: parsed.data.name },
      });
      return NextResponse.json(serialize(section));
    }

    const section = await prisma.section.update({
      where: { id: sectionId },
      data: { status: parsed.data.status },
    });
    return NextResponse.json(serialize(section));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

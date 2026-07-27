import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { ADMIN_COOKIE, verifySessionToken } from "@/lib/auth";
import { getClerkUserId } from "@/lib/stripe";

// Dettaglio pubblico per slug: solo siti published (i draft restano
// visibili all'admin loggato, così può fare preview)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  const site = await prisma.site.findUnique({
    where: { slug },
    include: {
      // rank (Fase 4, solo origin "ast") prima, poi nome — i componenti "ai"
      // (url-sourced) hanno rank null e Postgres li ordina ASC NULLS LAST.
      components: { orderBy: [{ rank: "asc" }, { name: "asc" }] },
      documents: {
        select: { id: true, path: true, kind: true, summary: true },
        orderBy: { path: "asc" },
      },
      // Sezioni pubblicate dallo studio di ricostruzione assistita
      // (src/lib/reconstruction/publish.ts) — sostituiscono i Component
      // come unità mostrata pubblicamente (vedi piano Viewsource v2).
      sections: {
        where: { filePath: { not: null } },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!site) {
    return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
  }

  if (site.visibility !== "published") {
    const isAdmin = await verifySessionToken(
      req.cookies.get(ADMIN_COOKIE)?.value
    );
    if (!isAdmin) {
      return NextResponse.json({ error: "Sito non trovato" }, { status: 404 });
    }
  }

  // Sito gratis (nessun price) → codice sempre sbloccato. Sito a pagamento →
  // sbloccato solo se l'utente Clerk corrente ha un Unlock per questo sito.
  let unlocked = !site.price;
  if (site.price) {
    const userId = await getClerkUserId();
    if (userId) {
      const unlock = await prisma.unlock.findUnique({
        where: { userId_siteId: { userId, siteId: site.id } },
      });
      unlocked = !!unlock;
    }
  }

  // Il codice cache (già estratto in passato, es. da admin) non deve
  // trapelare a chi non ha sbloccato il sito: il gate vive anche qui, non
  // solo sull'endpoint di estrazione — altrimenti basterebbe il GET.
  // `excluded` filtrati del tutto: l'admin li ha tenuti fuori dalla vetrina,
  // non solo nascosti in UI. `bundleFiles` è gated come `code`/`deps` (stessa
  // ragione: è il codice completo dei componenti origin "ast").
  const visibleComponents = site.components.filter((c) => !c.excluded);
  const components = site.price && !unlocked
    ? visibleComponents.map((c) => ({ ...c, code: null, deps: null, bundleFiles: null }))
    : visibleComponents;

  // Stesso gate delle sezioni pubblicate: il prompt (gratuito) resta sempre
  // visibile, il codice completo (generatedCode) no.
  const sections = site.price && !unlocked
    ? site.sections.map((s) => ({ ...s, generatedCode: null }))
    : site.sections;

  return NextResponse.json({ ...site, components, sections, unlocked });
}

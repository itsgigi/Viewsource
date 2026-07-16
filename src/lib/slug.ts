import { prisma } from "@/lib/db";

export function kebabCase(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slug unico dal nome: kebab-case, dedupe con suffisso numerico. */
export async function uniqueSlug(name: string): Promise<string> {
  const base = kebabCase(name) || "site";
  let slug = base;
  for (let i = 2; ; i++) {
    const existing = await prisma.site.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!existing) return slug;
    slug = `${base}-${i}`;
  }
}

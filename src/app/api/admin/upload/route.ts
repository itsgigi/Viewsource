import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

// Upload media (cover di siti e componenti) su Vercel Blob.
// Protetto dal proxy (path /api/admin/*). Richiede BLOB_READ_WRITE_TOKEN.
// Nota: su Vercel il body delle serverless function è limitato a ~4.5MB;
// per video più pesanti caricare altrove e incollare l'URL.
export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN non configurato" },
      { status: 500 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "File mancante" }, { status: 400 });
  }

  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    return NextResponse.json(
      { error: "Solo immagini o video" },
      { status: 400 }
    );
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
  const blob = await put(`covers/${Date.now()}-${safeName}`, file, {
    access: "public",
  });

  return NextResponse.json({
    url: blob.url,
    coverType: file.type.startsWith("video/") ? "video" : "image",
  });
}

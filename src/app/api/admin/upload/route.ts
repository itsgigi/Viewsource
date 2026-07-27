import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";

// Upload media (site and component covers) to Vercel Blob.
// Protected by the proxy (path /api/admin/*). Requires BLOB_READ_WRITE_TOKEN.
// Note: on Vercel the serverless function body is limited to ~4.5MB;
// for heavier videos, upload elsewhere and paste the URL.
export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "BLOB_READ_WRITE_TOKEN not configured" },
      { status: 500 }
    );
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
    return NextResponse.json(
      { error: "Images or videos only" },
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

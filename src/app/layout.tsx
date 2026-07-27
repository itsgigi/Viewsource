import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Site Ingest",
  description: "Ingest any site. Extract its components.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const markup = (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );

  // Auth utenti pubblici (Clerk) separata dal cookie admin. Se le chiavi
  // Clerk non sono configurate, l'app resta comunque buildabile e usabile
  // (solo le funzionalità legate all'unlock/checkout non funzionano finché
  // non vengono aggiunte NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY).
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return markup;

  return <ClerkProvider>{markup}</ClerkProvider>;
}

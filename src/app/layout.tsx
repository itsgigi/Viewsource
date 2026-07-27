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
  title: "Viewsource",
  description: "Recreate. Learn. Own the code.",
  icons: {
    icon: "/logovs.png",
    shortcut: "/logovs.png",
    apple: "/logovs.png",
  },
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

  // Public user auth (Clerk), separate from the admin cookie. If the Clerk
  // keys aren't configured, the app still builds and works fine (only the
  // unlock/checkout features won't work until NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  // + CLERK_SECRET_KEY are added).
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) return markup;

  return <ClerkProvider>{markup}</ClerkProvider>;
}

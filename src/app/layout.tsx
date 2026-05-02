import type { Metadata } from "next";
import { Geist, Geist_Mono, Bebas_Neue } from "next/font/google";
import "./globals.css";
import { SwRegister } from "@/components/SwRegister";
import { VisibilityHandler } from "@/components/VisibilityHandler";
import { WakeLockHandler } from "@/components/WakeLockHandler";
import { Toaster } from "@/components/Toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const bebas = Bebas_Neue({
  variable: "--font-bebas",
  weight: "400",
  subsets: ["latin"],
});

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Cypher",
  description: "A pocket DAW for sketching musical ideas.",
  applicationName: "Cypher",
  manifest: `${BASE}/manifest.webmanifest`,
  appleWebApp: {
    capable: true,
    title: "Cypher",
    statusBarStyle: "black-translucent",
  },
  icons: {
    apple: `${BASE}/icon-192.png`,
    icon: [
      { url: `${BASE}/icon-192.png`, sizes: "192x192" },
      { url: `${BASE}/icon-512.png`, sizes: "512x512" },
    ],
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#050a18",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${bebas.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SwRegister />
        <VisibilityHandler />
        <WakeLockHandler />
        {children}
        <Toaster />
      </body>
    </html>
  );
}

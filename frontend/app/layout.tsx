import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "./providers";
import { TopNav } from "@/components/layout/top-nav";
import { TopNavSkeleton } from "@/components/layout/top-nav-skeleton";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Dante",
  description: "Personio-backed customer, project, and allocation management.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // Some browser extensions (password managers, adblockers, theme tools)
      // inject attributes onto <html> after the server rendered it. React
      // can't see those at SSR time, which trips its hydration check. This
      // suppresses the mismatch warning *only* for this element's attribute
      // set — child elements are still hydration-checked normally.
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          {/* TopNav reads the session (cookies). Behind Suspense so the
              layout prerenders into the static shell and the nav streams
              in per request — without this every route, even /_not-found,
              blocks on the session read under Cache Components. */}
          <Suspense fallback={<TopNavSkeleton />}>
            <TopNav />
          </Suspense>
          <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-8">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}

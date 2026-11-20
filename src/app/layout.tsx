import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { ToastProvider } from "@/components/ui/Toast";
import { TooltipProvider } from "@/components/ui/Tooltip";
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
  title: "LeadCockpit",
  description: "Agent-assisted B2B lead generation cockpit",
};

/**
 * 2026-08-24 (P0-CSP) — this layout MUST read a request header, and the read is
 * the point, not a side effect.
 *
 * src/middleware.ts mints a fresh CSP nonce per request and puts it in the
 * `script-src` of the response header. Next only stamps that nonce onto the
 * inline bootstrap scripts it emits when it renders the page PER REQUEST. Left
 * alone, every route here is statically prerendered at build time, so the HTML
 * ships with no nonce at all while the header still demands one — the browser
 * then blocks all six inline scripts, React never hydrates, and the entire app
 * is a dead shell: it paints, nothing works, and not one API call is made.
 *
 * Dev never showed this because dev renders every request dynamically. It only
 * appears in a production build, which is exactly what the Docker image ships.
 * Found 2026-08-24 by the first browser run against `next start`.
 *
 * Reading headers() opts every route under this layout into dynamic rendering,
 * which is what makes the nonce real. The value is deliberately unused — these
 * pages are a client shell, so there is nothing static to lose.
 *
 * Pinned by scripts/golden/golden-csp-nonce.ts.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await headers();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* 2026-07-21 (M1): ToastProvider wraps the whole app so any
            screen can fire toasts via useToast(). Replaces the 1-line
            header StatusPill that overwrote errors with the next action.
            2026-08-02 (UX redesign): TooltipProvider added for the Tooltip
            primitive (Radix requires a single provider at the app root). */}
        <ToastProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ToastProvider>
      </body>
    </html>
  );
}

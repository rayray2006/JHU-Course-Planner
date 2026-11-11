import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
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
  title: "JHU Course Planner",
  description: "AI-powered course planning for Johns Hopkins University",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  // Matches --surface-page in the light theme, which is what nearly everyone
  // sees. A `media` split would key off the OS preference rather than the
  // class we actually render with, so it would be wrong more often than this.
  themeColor: "#f8fafc",
};

/**
 * Runs before first paint, ahead of React, so nobody gets a white flash while
 * hydration catches up. It has to be inline and synchronous for that: an
 * imported module would load too late to matter.
 *
 * Light is the default here, not the OS preference — only an explicit "dark"
 * opts in. So the one case that needs the store to be readable is the
 * minority one, and an unreadable store (private windows throw) lands on the
 * default rather than on a guess. The try/catch is what keeps that throw from
 * blocking the document.
 */
const THEME_INIT = `
(function () {
  try {
    if (localStorage.getItem('theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
      // The script above adds `dark` to this element before React sees it, so
      // the server's class list and the client's legitimately differ.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="h-full overflow-hidden">
        {children}
        <Analytics />
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import AnimatedFavicon from "../components/AnimatedFavicon";
import "./globals.css";

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const displayFont = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata: Metadata = {
  title: "JobHunt India — Find your next move",
  description:
    "A cinematic job-discovery experience for GenAI, Data Engineering and UI/UX roles across India. Real listings, real links, updated daily.",
  robots: { index: false, follow: false },
  icons: {
    icon: [
      { url: "/favicon.svg?v=5", type: "image/svg+xml", sizes: "any" },
      { url: "/favicon-32.png?v=5", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16.png?v=5", type: "image/png", sizes: "16x16" },
    ],
    shortcut: "/favicon.ico?v=5",
    apple: "/apple-touch-icon.png?v=5",
  },
  manifest: "/manifest.json?v=5",
};

export const viewport: Viewport = {
  themeColor: "#08090D",
  width: "device-width",
  initialScale: 1,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bodyFont.variable} ${displayFont.variable}`}>
      <head>
        <link
          rel="preload"
          href="/models/student/student.glb"
          as="fetch"
          type="model/gltf-binary"
          crossOrigin="anonymous"
        />
        <link rel="icon" href="/favicon.ico?v=5" sizes="any" />
        <link rel="mask-icon" href="/favicon.svg?v=5" color="#FF304F" />
      </head>
      <body>
        <AnimatedFavicon />
        {children}
      </body>
    </html>
  );
}

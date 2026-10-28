import type { Metadata, Viewport } from "next";
import { ToastProvider } from "@/components/ui/toast";
import { env } from "@/server/env";
import "./globals.css";

export function generateMetadata(): Metadata {
  const name = env().APP_NAME;
  return {
    title: { default: `${name} — the football player stock market`, template: `%s | ${name}` },
    description: "Buy and sell players from Europe's top leagues with virtual credits. Prices move with real match performance. Compete with friends in private leagues. No real money, ever.",
    applicationName: name,
    robots: { index: true, follow: true },
  };
}

export const viewport: Viewport = {
  themeColor: "#08130f",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body className="min-h-dvh">
        <a href="#main" className="sr-only z-[70] rounded bg-lime px-3 py-2 text-pitch-950 focus:not-sr-only focus:fixed focus:top-3 focus:left-3">
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}

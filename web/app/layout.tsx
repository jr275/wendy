import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "@copilotkit/react-core/v2/styles.css";
import "./globals.css";
import { Suspense } from "react";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Menlo · Wendy",
  description: "Remax AI Platform — a inteligência executiva que antecipa o que importa.",
};

/**
 * Runs before first paint: applies the saved theme and mirrors it as the `dark` class,
 * which CopilotKit's chat styles key on. Follows the system setting when nothing is saved.
 */
const THEME_BOOT = `(function(){try{var d=document.documentElement,s=localStorage.getItem("wendy.theme"),m=window.matchMedia("(prefers-color-scheme: dark)");if(s)d.dataset.theme=s;var a=function(){var t=d.dataset.theme||(m.matches?"dark":"light");d.classList.toggle("dark",t==="dark")};a();m.addEventListener("change",a);new MutationObserver(a).observe(d,{attributes:true,attributeFilter:["data-theme"]})}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* CopilotKit reads the clock when it mounts; keep it out of the prerendered shell. */}
        <Suspense fallback={null}>
          <Providers>{children}</Providers>
        </Suspense>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Codex Explorer",
  description: "A private, local Codex workspace with unified search, SQLite browsing, Markdown Memory editing and forgetting, session thread trees, and saved token/quota reports.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){var p="system";try{var s=localStorage.getItem("codex-explorer-appearance");if(s==="light"||s==="dark")p=s}catch(e){}var h=document.documentElement;h.dataset.appearance=p;h.dataset.theme=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p})()` }} />
      </head>
      <body className={`${geist.variable} ${mono.variable}`}>{children}</body>
    </html>
  );
}

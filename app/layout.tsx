import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  Bricolage_Grotesque,
  Martian_Mono,
  Schibsted_Grotesk,
} from "next/font/google";
import { NavHeader } from "@/app/components/NavHeader";
import "./globals.css";

/*
 * Three faces, three jobs. Display carries the personality and is used with
 * restraint (wordmark, one claim per page, the big readouts); body does the
 * reading; mono is the instrument face — its width axis is narrowed for the
 * live wire and left at 100 for labels. All self-hosted by next/font.
 */
const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["opsz", "wdth"],
  variable: "--nf-display",
  display: "swap",
});
const body = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--nf-body",
  display: "swap",
});
const mono = Martian_Mono({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--nf-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rainmaker",
  description:
    "Finds the companies that will need a marketing agency this quarter, and says why.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${display.variable} ${body.variable} ${mono.variable}`}
    >
      <body>
        <div className="page">
          <NavHeader />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

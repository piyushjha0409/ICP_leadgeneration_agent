import type { Metadata } from "next";
import type { ReactNode } from "react";
import { NavHeader } from "@/app/components/NavHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Rainmaker",
  description: "Autonomous ICP lead-generation agent",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="page">
          <NavHeader />
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Setup" },
  { href: "/run", label: "Run" },
  { href: "/leads", label: "Leads" },
];

export function NavHeader() {
  const pathname = usePathname();

  return (
    <div className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand">
          Rain<span className="drop">maker</span>
        </Link>
        <nav className="nav-links">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={active ? "active" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

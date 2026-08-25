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
    <header className="nav">
      <div className="nav-inner">
        <Link href="/" className="brand" aria-label="Rainmaker home">
          Rain<span className="drop">maker</span>
        </Link>
        <nav className="nav-links" aria-label="Sections">
          {LINKS.map((link) => {
            const active =
              link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

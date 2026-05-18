"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function Navbar() {
  const [q, setQ] = useState("");
  const router = useRouter();
  const links = [
    { href: "/", label: "Dashboard" },
    { href: "/scanner", label: "Scanner" },
    { href: "/earnings", label: "Earnings" },
    { href: "/post-earnings", label: "Post-Earnings" },
    { href: "/tracker", label: "Tracker" },
  ];

  const search = () => {
    const t = q.trim().toUpperCase();
    if (t) {
      router.push(`/stock/${t}`);
      setQ("");
    }
  };

  return (
    <nav className="border-b border-border bg-card sticky top-0 z-50">
      <div className="max-w-screen-2xl mx-auto px-3 sm:px-4">
        <div className="h-12 sm:h-14 flex items-center gap-3 sm:gap-6">
          <Link href="/" className="text-accent font-bold text-lg sm:text-xl tracking-tight shrink-0">
            StockPulse
          </Link>

          <div className="hidden sm:flex gap-4 text-sm text-muted">
            {links.map(link => (
              <Link key={link.href} href={link.href} className="hover:text-white transition-colors">
                {link.label}
              </Link>
            ))}
          </div>

          <div className="ml-auto flex min-w-0 gap-1.5 sm:gap-2">
            <input
              className="w-28 sm:w-40 bg-surface border border-border rounded-lg px-2.5 sm:px-3 py-1.5 text-sm text-white placeholder-muted focus:outline-none focus:border-accent"
              placeholder="Search ticker..."
              value={q}
              onChange={(e) => setQ(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && search()}
            />
            <button
              onClick={search}
              className="bg-accent text-black text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-accent/80"
            >
              Go
            </button>
          </div>
        </div>

        <div className="sm:hidden -mx-3 border-t border-border/60 overflow-x-auto">
          <div className="flex min-w-max gap-1 px-3 py-2">
            {links.map(link => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-semibold text-muted hover:border-accent/50 hover:text-white"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}

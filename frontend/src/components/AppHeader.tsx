import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useLive } from "@/components/LiveProvider";
import { formatTime, headerSummary } from "@/lib/live/derive";
import { Menu, X, LayoutDashboard, Network, Clock } from "lucide-react";
import { HivemindLogo } from "@/components/HivemindLogo";

const links = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/map", label: "Network Map", icon: Network },
  { to: "/timeline", label: "Timeline", icon: Clock },
] as const;

export function AppHeader() {
  const [open, setOpen] = useState(false);
  const live = useLive();
  const { now } = headerSummary(live);
  const offline = live.status !== "connected";
  return (
    <>
      <header className="sticky top-0 z-40 glass flex h-14 items-center gap-3 px-4">
        <button aria-label="Open menu" onClick={() => setOpen(true)} className="rounded p-2 text-primary hover:bg-secondary">
          <Menu className="h-5 w-5" />
        </button>
        <Link to="/" className="flex items-center gap-2">
          <HivemindLogo className="h-6 w-6 drop-shadow-[0_0_3px_oklch(0.82_0.13_200/0.6)]" />
          <span className="font-mono text-lg font-bold tracking-[0.3em] text-primary glow-cyan">HIVEMIND</span>
        </Link>
        <span className="ml-auto hidden font-mono text-xs text-muted-foreground sm:block">{offline ? <span className="text-destructive">{live.status === "connecting" ? "CONNECTING TO BACKEND…" : "BACKEND OFFLINE"}</span> : <>{live.dataset ? `${live.dataset.datasetId} // ` : ""}{now ? formatTime(now) : "NO ACTIVE DATASET"}</>}</span>
      </header>
      {open && <div className="fixed inset-0 z-40 bg-background/70" onClick={() => setOpen(false)} />}
      <nav className={`fixed left-0 top-0 z-50 h-full w-72 glass transition-transform duration-300 ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-14 items-center justify-between px-4">
          <span className="font-mono text-sm tracking-[0.3em] text-accent glow-magenta">NAVIGATION</span>
          <button aria-label="Close menu" onClick={() => setOpen(false)} className="p-2 text-primary"><X className="h-5 w-5" /></button>
        </div>
        <ul className="space-y-2 p-4">
          {links.map((l) => (
            <li key={l.to}>
              <Link to={l.to} onClick={() => setOpen(false)} activeOptions={{ exact: true }}
                className="clip-corner flex items-center gap-3 border border-border px-4 py-3 font-mono text-sm uppercase tracking-widest text-muted-foreground transition hover:text-primary data-[status=active]:bg-primary data-[status=active]:text-primary-foreground">
                <l.icon className="h-4 w-4" /> {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

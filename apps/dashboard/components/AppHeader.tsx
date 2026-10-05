import Link from "next/link";

export function AppHeader({ title, meta }: { title: string; meta?: React.ReactNode }) {
  return (
    <div className="app-header">
      <div className="app-title">
        <Link href="/" className="brand">
          voxobs
        </Link>
        <span className="dim"> — {title}</span>
      </div>
      <nav className="nav">
        <Link href="/">live</Link>
        <Link href="/history">history</Link>
      </nav>
      {meta ? <div className="meta">{meta}</div> : <div className="meta" />}
    </div>
  );
}

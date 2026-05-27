'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links: { href: string; label: string; match?: (p: string) => boolean }[] = [
  { href: '/', label: '创作', match: p => p === '/' },
  { href: '/history', label: '工作台', match: p => p.startsWith('/history') || p.startsWith('/workspace') },
  { href: '/history?tab=completed', label: '最近预览', match: p => p.startsWith('/preview') }
];

export default function TopNav() {
  const pathname = usePathname() ?? '/';
  return (
    <header className="topnav">
      <div className="topnav-inner">
        <Link className="brand" href="/" aria-label="Frame home">
          <span className="brand-mark" aria-hidden />
          <span>Frame</span>
        </Link>
        <nav className="nav-links" aria-label="主导航">
          {links.map(l => {
            const active = l.match ? l.match(pathname) : pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`nav-link${active ? ' is-active' : ''}`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <span className="nav-spacer" />
        <div className="search-mini" role="search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <span>搜索任务、关键帧、模板…</span>
          <kbd>⌘ K</kbd>
        </div>
        <span className="avatar" title="Local">U</span>
      </div>
    </header>
  );
}

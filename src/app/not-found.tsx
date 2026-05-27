import Link from 'next/link';
import TopNav from '@/components/TopNav';

export default function NotFound() {
  return (
    <>
      <TopNav />
      <main style={{ maxWidth: 600, margin: '120px auto', textAlign: 'center' }}>
        <h1 style={{ fontSize: 56, letterSpacing: '-0.03em' }}>404</h1>
        <p style={{ color: 'var(--muted)', marginTop: 12 }}>找不到这个页面或任务。可能它已经被删除了。</p>
        <div style={{ marginTop: 24 }}>
          <Link className="btn btn-accent" href="/">回到创作台</Link>
        </div>
      </main>
    </>
  );
}

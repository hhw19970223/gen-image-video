import Link from 'next/link';
import TopNav from '@/components/TopNav';
import HomeView from '@/components/HomeView';
import { listTasks, homeStats } from '@/lib/repo';
import { serializeTask } from '@/lib/api-helpers';
import { checkComfyUI } from '@/lib/comfyui';
import './home.css';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const tasks = listTasks({ limit: 8 }).map(serializeTask);
  const stats = homeStats();
  const comfyui = await checkComfyUI(1200);
  const env = {
    comfyui,
    codex: !!process.env.CODEX_BIN
  };
  return (
    <>
      <TopNav />
      <main>
        <HomeView tasks={tasks} stats={stats} env={env} />
        <footer className="home-footer">
          <Link className="btn btn-sm" href="/history">所有任务 →</Link>
        </footer>
      </main>
    </>
  );
}

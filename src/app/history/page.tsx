import TopNav from '@/components/TopNav';
import HistoryView from '@/components/HistoryView';
import { listTasks } from '@/lib/repo';
import { serializeTask } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tasks = listTasks({ limit: 100 }).map(serializeTask);
  return (
    <>
      <TopNav />
      <main>
        <HistoryView tasks={tasks} initialTab={sp.tab ?? 'all'} />
      </main>
    </>
  );
}

import { notFound } from 'next/navigation';
import TopNav from '@/components/TopNav';
import WorkspaceView from '@/components/WorkspaceView';
import { fullTask } from '@/lib/api-helpers';
import { getTask, listTasks } from '@/lib/repo';
import { serializeTask } from '@/lib/api-helpers';
import './workspace.css';

export const dynamic = 'force-dynamic';

export default async function WorkspacePage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) notFound();
  const initial = fullTask(taskId, t);
  const sidebarTasks = listTasks({ limit: 20 }).map(serializeTask);
  return (
    <>
      <TopNav />
      <WorkspaceView initial={initial} sidebarTasks={sidebarTasks} />
    </>
  );
}

import { notFound } from 'next/navigation';
import TopNav from '@/components/TopNav';
import PreviewView from '@/components/PreviewView';
import { fullTask } from '@/lib/api-helpers';
import { getTask } from '@/lib/repo';
import './preview.css';

export const dynamic = 'force-dynamic';

export default async function PreviewPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const t = getTask(taskId);
  if (!t) notFound();
  const initial = fullTask(taskId, t);
  return (
    <>
      <TopNav />
      <PreviewView initial={initial} />
    </>
  );
}

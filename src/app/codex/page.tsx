import TopNav from '@/components/TopNav';
import CodexChatView from '@/components/CodexChatView';
import { getActiveCodexSession, listCodexMessages } from '@/lib/repo';
import './codex.css';

export const dynamic = 'force-dynamic';

export default async function CodexPage() {
  const active = getActiveCodexSession();
  const codexConfigured = Boolean(process.env.CODEX_BIN?.trim());
  return (
    <>
      <TopNav />
      <main>
        <CodexChatView
          initialActive={active}
          initialMessages={listCodexMessages(active.id)}
          codexConfigured={codexConfigured}
        />
      </main>
    </>
  );
}

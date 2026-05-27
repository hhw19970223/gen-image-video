import Database from 'better-sqlite3';
import { DB_PATH, ensureDirs } from './paths';

ensureDirs();

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS video_tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      generation_prompt TEXT,
      generation_negative_prompt TEXT,
      reference_image_path TEXT,
      style TEXT,
      aspect_ratio TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      duration REAL NOT NULL,
      fps INTEGER NOT NULL,
      frame_count INTEGER NOT NULL,
      motion_type TEXT NOT NULL,
      seed INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      progress INTEGER NOT NULL DEFAULT 0,
      stage_message TEXT,
      video_path TEXT,
      cover_path TEXT,
      cache_keyframe_hits INTEGER NOT NULL DEFAULT 0,
      cache_motion_hits INTEGER NOT NULL DEFAULT 0,
      cache_video_hit INTEGER NOT NULL DEFAULT 0,
      cost_estimate REAL NOT NULL DEFAULT 0,
      cost_saved REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      codex_app_thread_id TEXT,
      codex_exec_thread_id TEXT,
      codex_exec_model TEXT,
      confirmed_plan_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS keyframes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES video_tasks(id) ON DELETE CASCADE,
      frame_index INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      generation_prompt TEXT,
      seed INTEGER NOT NULL,
      image_path TEXT,
      thumbnail_path TEXT,
      cache_key TEXT NOT NULL,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_keyframes_task ON keyframes(task_id, frame_index);

    CREATE TABLE IF NOT EXISTS cache_records (
      id TEXT PRIMARY KEY,
      cache_key TEXT UNIQUE NOT NULL,
      cache_type TEXT NOT NULL,
      file_path TEXT NOT NULL,
      meta TEXT,
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_hit_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cache_key ON cache_records(cache_key);
    CREATE INDEX IF NOT EXISTS idx_cache_type ON cache_records(cache_type);

    CREATE TABLE IF NOT EXISTS chat_logs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES video_tasks(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chat_task ON chat_logs(task_id, created_at);
  `);

  ensureColumn(d, 'video_tasks', 'codex_app_thread_id', 'TEXT');
  ensureColumn(d, 'video_tasks', 'codex_exec_thread_id', 'TEXT');
  ensureColumn(d, 'video_tasks', 'codex_exec_model', 'TEXT');
  ensureColumn(d, 'video_tasks', 'confirmed_plan_json', 'TEXT');
  ensureColumn(d, 'video_tasks', 'generation_prompt', 'TEXT');
  ensureColumn(d, 'video_tasks', 'generation_negative_prompt', 'TEXT');
  ensureColumn(d, 'keyframes', 'generation_prompt', 'TEXT');
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_codex_app_thread ON video_tasks(codex_app_thread_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_codex_exec_thread ON video_tasks(codex_exec_thread_id);
  `);
}

function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  definition: string
): void {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some(c => c.name === column)) {
    d.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

/** Touch updated_at on a video_tasks row. */
export function touchTask(taskId: string): void {
  db()
    .prepare(`UPDATE video_tasks SET updated_at = datetime('now') WHERE id = ?`)
    .run(taskId);
}

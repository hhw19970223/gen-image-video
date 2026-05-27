// In-process event bus —— 用于把 worker 进度推到 SSE 路由

import { EventEmitter } from 'node:events';

export interface TaskEvent {
  taskId: string;
  type: 'status' | 'progress' | 'frame' | 'log' | 'completed' | 'failed';
  payload: unknown;
  ts: number;
}

class TaskBus extends EventEmitter {
  emitTask(taskId: string, ev: Omit<TaskEvent, 'taskId' | 'ts'>): void {
    const full: TaskEvent = { taskId, ts: Date.now(), ...ev };
    this.emit(taskId, full);
    this.emit('*', full);
  }
}

const g = globalThis as unknown as { __frameBus?: TaskBus };
if (!g.__frameBus) g.__frameBus = new TaskBus();
g.__frameBus.setMaxListeners(0);

export const bus: TaskBus = g.__frameBus;

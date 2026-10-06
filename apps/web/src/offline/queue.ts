import type { GameEventDraft } from '@openhoopscore/contracts';
import type { PendingEntry } from './derive';

/**
 * ============================================================================
 * 本地事件队列（IndexedDB 优先，localStorage 兜底）
 * ============================================================================
 * 这是「离线优先」的地基：计分员每点一下，事件**先落本地**，再尝试发往服务端。
 * 只要这一步是同步可靠地完成的，后面网络怎么抖都不会丢数据。
 *
 * 为什么优先 IndexedDB：
 *   - 容量：localStorage 只有 5MB 左右，一场比赛几百条事件加上后续扩展会紧张；
 *   - 事务：IndexedDB 写入是事务性的，平板被强杀/断电不会留下半条记录。
 * 为什么还要 localStorage 兜底：
 *   - 隐私模式、部分老旧 WebView 会禁用 IndexedDB。此时降级仍然比「完全没有离线能力」强，
 *     并且 UI 会明确提示存储能力受限。
 *
 * 注意：这个模块**不 import** 任何业务代码，可以单独测试与替换。
 */

export interface QueueStorage {
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
  init(): Promise<void>;
  load(matchId: string, clientId: string): Promise<PendingEntry[]>;
  save(matchId: string, clientId: string, entries: PendingEntry[]): Promise<void>;
  /** 按 matchId 清空（比赛结束后释放平板空间）。 */
  clear(matchId: string): Promise<void>;
}

const DB_NAME = 'openhoopscore';
const DB_VERSION = 1;
const STORE = 'pending-events';

class IndexedDbQueueStorage implements QueueStorage {
  readonly kind = 'indexeddb' as const;
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB 打开失败'));
      request.onblocked = () => reject(new Error('IndexedDB 被其它标签页占用'));
    });
  }

  private key(matchId: string, clientId: string): string {
    return `${matchId}::${clientId}`;
  }

  async load(matchId: string, clientId: string): Promise<PendingEntry[]> {
    await this.init();
    return new Promise<PendingEntry[]>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(this.key(matchId, clientId));
      request.onsuccess = () => resolve((request.result as PendingEntry[] | undefined) ?? []);
      request.onerror = () => reject(request.error ?? new Error('读取本地队列失败'));
    });
  }

  async save(matchId: string, clientId: string, entries: PendingEntry[]): Promise<void> {
    await this.init();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      // 整批覆盖写：队列本身很小（几百条），覆盖写比增量更新简单可靠得多
      tx.objectStore(STORE).put(entries, this.key(matchId, clientId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('写入本地队列失败'));
      tx.onabort = () => reject(tx.error ?? new Error('写入本地队列被中止'));
    });
  }

  async clear(matchId: string): Promise<void> {
    await this.init();
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (String(cursor.key).startsWith(`${matchId}::`)) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('清理本地队列失败'));
    });
  }
}

class LocalStorageQueueStorage implements QueueStorage {
  readonly kind = 'localstorage' as const;

  async init(): Promise<void> {
    /* localStorage 无需初始化 */
  }

  private key(matchId: string, clientId: string): string {
    return `hoop:queue:${matchId}:${clientId}`;
  }

  async load(matchId: string, clientId: string): Promise<PendingEntry[]> {
    try {
      const raw = window.localStorage.getItem(this.key(matchId, clientId));
      return raw ? (JSON.parse(raw) as PendingEntry[]) : [];
    } catch {
      return [];
    }
  }

  async save(matchId: string, clientId: string, entries: PendingEntry[]): Promise<void> {
    window.localStorage.setItem(this.key(matchId, clientId), JSON.stringify(entries));
  }

  async clear(matchId: string): Promise<void> {
    const prefix = `hoop:queue:${matchId}:`;
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  }
}

class MemoryQueueStorage implements QueueStorage {
  readonly kind = 'memory' as const;
  private map = new Map<string, PendingEntry[]>();

  async init(): Promise<void> {}

  async load(matchId: string, clientId: string): Promise<PendingEntry[]> {
    return this.map.get(`${matchId}::${clientId}`) ?? [];
  }

  async save(matchId: string, clientId: string, entries: PendingEntry[]): Promise<void> {
    this.map.set(`${matchId}::${clientId}`, entries);
  }

  async clear(matchId: string): Promise<void> {
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(`${matchId}::`)) this.map.delete(key);
    }
  }
}

/** 按当前环境挑一个可用的存储实现（IndexedDB → localStorage → 内存）。 */
export async function createQueueStorage(): Promise<QueueStorage> {
  try {
    if (typeof indexedDB !== 'undefined') {
      const storage = new IndexedDbQueueStorage();
      await storage.init();
      return storage;
    }
  } catch {
    // 隐私模式 / 老旧 WebView：继续往下试
  }

  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const probe = '__hoop_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      const storage = new LocalStorageQueueStorage();
      await storage.init();
      return storage;
    }
  } catch {
    // 被策略禁用
  }

  const storage = new MemoryQueueStorage();
  await storage.init();
  return storage;
}

export function makePendingEntry(event: GameEventDraft): PendingEntry {
  return {
    clientEventId: event.clientEventId,
    attempts: 0,
    createdAt: new Date().toISOString(),
    event,
  };
}

/**
 * 跨标签页互斥锁：代际补刻「两个标签页同时提交确认时只有一份能生效」。
 * 优先使用 Web Locks API（navigator.locks，Chromium 原生支持）；
 * 不支持时回退到 localStorage 互斥量 + storage 事件通知。
 */

const LOCK_NAME = 'gbmovabletype-recarve-migration';
const FALLBACK_KEY = 'gbmovabletype-lock:recarve';

type ReleaseFn = () => void;

/** 回退方案：localStorage 互斥量（带超时，避免标签页崩溃后死锁） */
function withLocalMutex<T>(fn: () => Promise<T>): Promise<T> {
  const TIMEOUT_MS = 15000;
  const WAIT_MS = 120;
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const acquire = (): Promise<ReleaseFn> =>
    new Promise((resolve) => {
      const tryAcquire = () => {
        try {
          const raw = localStorage.getItem(FALLBACK_KEY);
          if (raw) {
            const { token: owner, at } = JSON.parse(raw) as { token: string; at: number };
            // 持有者超时未释放，视为崩溃，强制接管
            if (owner !== token && Date.now() - at < TIMEOUT_MS) return false;
          }
          localStorage.setItem(FALLBACK_KEY, JSON.stringify({ token, at: Date.now() }));
          return true;
        } catch {
          return true; // 存储不可用时不阻塞业务
        }
      };
      if (tryAcquire()) {
        resolve(() => {
          try {
            const raw = localStorage.getItem(FALLBACK_KEY);
            const owner = raw ? (JSON.parse(raw) as { token: string }).token : '';
            if (owner === token) localStorage.removeItem(FALLBACK_KEY);
          } catch {
            /* 忽略 */
          }
        });
        return;
      }
      const timer = window.setInterval(() => {
        if (tryAcquire()) {
          window.clearInterval(timer);
          resolve(() => {
            try {
              const raw = localStorage.getItem(FALLBACK_KEY);
              const owner = raw ? (JSON.parse(raw) as { token: string }).token : '';
              if (owner === token) localStorage.removeItem(FALLBACK_KEY);
            } catch {
              /* 忽略 */
            }
          });
        }
      }, WAIT_MS);
    });

  return acquire().then(async (release) => {
    try {
      return await fn();
    } finally {
      release();
    }
  });
}

/** 在跨标签页互斥锁内执行关键区代码；同一时刻只有一个标签页能进入 */
export async function withRecarveLock<T>(fn: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
    return navigator.locks.request(LOCK_NAME, { mode: 'exclusive' }, () => fn());
  }
  return withLocalMutex(fn);
}

/** 跨标签页通知渠道：批次变动后通知其它标签页刷新 */
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel('gbmovabletype-recarve');
  return channel;
}

/** 通知其它标签页：代际补刻批次有变动 */
export function notifyRecarveChanged(): void {
  try {
    getChannel()?.postMessage({ type: 'recarve-changed', at: Date.now() });
  } catch {
    /* 忽略 */
  }
}

/** 订阅其它标签页的批次变动通知；返回退订函数 */
export function subscribeRecarveChanged(cb: () => void): () => void {
  const ch = getChannel();
  const handler = () => cb();
  if (ch) {
    ch.addEventListener('message', handler);
  }
  // 回退：storage 事件（其它标签页写入 localStorage 时触发）
  const storageHandler = (e: StorageEvent) => {
    if (e.key === FALLBACK_KEY || e.key === null) cb();
  };
  window.addEventListener('storage', storageHandler);
  return () => {
    ch?.removeEventListener('message', handler);
    window.removeEventListener('storage', storageHandler);
  };
}

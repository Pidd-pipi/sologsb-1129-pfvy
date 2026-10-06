/**
 * 代际补刻批量迁移的跨标签页互斥锁。
 *
 * 正确性由迁移事务内的字盘版本复核保证（IndexedDB 写事务天然串行）：
 * 两个标签页同时提交时，后到的事务会看到版本已变化而整批回滚。
 * 此锁只用于更早地拦住第二个标签页，给出明确提示，避免两边都等事务。
 */
const LOCK_NAME = 'gbmovabletype-recut-migration';
const LOCK_KEY = 'gbmovabletype-recut-migration-lock';
const STALE_MS = 30_000;

interface LocksWithIfAvailable {
  request: (
    name: string,
    options: { mode: 'exclusive'; ifAvailable: boolean },
    callback: (lock: { name: string } | null) => Promise<void>,
  ) => Promise<void>;
}

type AnyNavigator = Navigator & { locks?: LocksWithIfAvailable };

function setFallbackLock(): boolean {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (raw) {
      const t = Number(raw);
      if (Number.isFinite(t) && Date.now() - t < STALE_MS) return false;
    }
    localStorage.setItem(LOCK_KEY, String(Date.now()));
    return true;
  } catch {
    // 存储不可用时不阻塞单标签页流程（事务内版本复核仍是最终防线）
    return true;
  }
}

function clearFallbackLock(): void {
  try {
    localStorage.removeItem(LOCK_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 在迁移锁内执行关键区：
 * - 优先用 Web Locks API 的 ifAvailable 模式，锁被别的标签页占用时回调收到 null；
 * - 不支持时退化为 localStorage 时间戳锁（超过 30s 视为残留死锁）。
 *
 * 返回 null 表示未拿到锁；否则返回关键区结果。
 */
export async function withMigrationLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const nav = typeof navigator !== 'undefined' ? (navigator as AnyNavigator) : undefined;
  if (nav?.locks?.request) {
    let acquired = false;
    let result: T;
    await nav.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) return;
      acquired = true;
      result = await fn();
    });
    return acquired ? result! : null;
  }

  if (!setFallbackLock()) return null;
  try {
    return await fn();
  } finally {
    clearFallbackLock();
  }
}

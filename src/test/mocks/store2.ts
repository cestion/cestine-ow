import { vi } from 'vitest';

/**
 * `store2` 的内存替身。
 *
 * 全仓只用到 `store2.get` / `store2.set` / `store2.remove` 三个方法
 * （`useAppLogin.ts`、`appRequest.ts`、`stores/global.ts` 等），
 * 这里把它们做成可断言的 spy，底层用 Map 而不是 localStorage，
 * 避免用例之间通过真实存储互相污染。
 *
 * 用法（必须写在测试文件顶层，`vi.mock` 才会被提升）：
 *
 * ```ts
 * vi.mock('store2', async () => {
 *   const { createStore2Mock } = await import('@/test/mocks/store2');
 *   return createStore2Mock();
 * });
 * ```
 *
 * 然后在用例里：
 *
 * ```ts
 * import { store2Backing, resetStore2Mock } from '@/test/mocks/store2';
 * store2Backing.set('userToken', 'tok_123');
 * ```
 */

/** 底层存储，测试可直接读写以摆状态或做断言 */
export const store2Backing = new Map<string, unknown>();

export function resetStore2Mock() {
  store2Backing.clear();
}

function buildStore2() {
  const get = vi.fn((key: string, alt?: unknown) =>
    store2Backing.has(key) ? store2Backing.get(key) : alt,
  );
  const set = vi.fn((key: string, value: unknown) => {
    store2Backing.set(key, value);
    return value;
  });
  const remove = vi.fn((key: string) => {
    const prev = store2Backing.get(key);
    store2Backing.delete(key);
    return prev;
  });
  const has = vi.fn((key: string) => store2Backing.has(key));
  const clearAll = vi.fn(() => {
    store2Backing.clear();
  });
  const keys = vi.fn(() => [...store2Backing.keys()]);
  const getAll = vi.fn(() => Object.fromEntries(store2Backing));

  // store2 本身可直接调用：store2('key') / store2('key', value)
  const callable = vi.fn((key?: string, value?: unknown) => {
    if (key === undefined) return getAll();
    if (value === undefined) return get(key);
    return set(key, value);
  });

  return Object.assign(callable, {
    get,
    set,
    remove,
    has,
    clearAll,
    keys,
    getAll,
    // store2.session / store2.local 命名空间指向同一份内存
    get session() {
      return callable;
    },
    get local() {
      return callable;
    },
    namespace: vi.fn(() => callable),
  });
}

/** 供 `vi.mock('store2', ...)` 工厂返回的模块形状 */
export function createStore2Mock() {
  const store = buildStore2();
  return { default: store, store2: store };
}

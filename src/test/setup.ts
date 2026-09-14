import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * 全局测试 setup，由 `vitest.config.ts` 的 setupFiles 加载。
 *
 * 关于环境变量：vitest 下 `import.meta.env.MODE === 'test'`，所以
 * `src/utils/env.ts` 里的 `IS_PRODUCTION` 与 `IS_DEVELOPMENT` 都是 false，
 * `SHOW_DEV_ONLY_UI` / `IS_DEV_ONLY_NAV_FEATURES_ENABLED` 都是 true
 * （等价于「非生产环境」）。要测另一个分支，在用例里 `vi.stubEnv('MODE', 'production')`
 * 并配合 `vi.resetModules()` 重新导入被测模块。
 */

// jsdom 不实现 matchMedia，next-themes / 响应式 hook 会直接炸
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// jsdom 不实现这两个 Observer，@use-gesture / react-intersection-observer 需要
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;
}
if (!globalThis.IntersectionObserver) {
  globalThis.IntersectionObserver =
    NoopObserver as unknown as typeof IntersectionObserver;
}

// jsdom 的 scrollTo 是未实现的 stub，调用会打 "Not implemented" 噪声
window.scrollTo = vi.fn();
Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

beforeEach(() => {
  // store2 走 localStorage；不清会导致用例之间互相污染登录态
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

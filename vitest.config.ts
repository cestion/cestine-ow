import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单测配置 —— 刻意不复用 `vite.config.ts`。
 *
 * `vite.config.ts` 挂了 tanstackStart() / nitro() / babel(reactCompilerPreset())
 * / tailwindcss()，跑单测时既慢又会把 SSR 副作用带进来。白盒单测只需要三样东西：
 * 路径别名、jsdom 环境、覆盖率。
 */
export default defineConfig({
  resolve: {
    // 镜像 vite.config.ts:42-47，保证测试里的 '@/...' / '~/...' 能解析
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '~': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // 不开 globals：测试文件显式 `import { describe, it, expect, vi } from 'vitest'`，
    // 这样 `pnpm typecheck` 不必往 tsconfig 里加 vitest/globals 类型。
    globals: false,
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      'src/api/__generated__/**',
      'src/solana/**',
    ],
    // 单个用例卡死不拖垮整批
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      // 有失败用例时也产出覆盖率，CI 汇总卡片需要这个数字
      reportOnFailure: true,
      reportsDirectory: './coverage',
      reporter: ['text-summary', 'json-summary', 'json', 'lcov'],
      // 只统计逻辑层。UI 渲染层（components/features/routes/layouts）不在
      // 「逻辑白盒测试」范畴内，混进来会把覆盖率基线稀释成无意义的数字。
      include: [
        'src/utils/**/*.ts',
        'src/lib/**/*.ts',
        'src/stores/**/*.ts',
        'src/hooks/**/*.ts',
        'src/api/*.ts',
      ],
      exclude: [
        'src/api/__generated__/**',
        'src/solana/**',
        'src/routeTree.gen.ts',
        'src/test/**',
        '**/__tests__/**',
        '**/*.stories.{ts,tsx}',
        '**/*.d.ts',
      ],
      // 阈值先不设。跑几轮拿到基线数字后再回来收紧（见 whitebox 计划）。
    },
  },
});

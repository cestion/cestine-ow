---
name: whitebox-testing
description: Run, write, and interpret white-box unit tests (Vitest) for this repo, and feed the results into AI code review. Use when asked to 跑白盒测试 / 补单测 / 看覆盖率 / 手动触发 CI 测试, when adding tests for utils, lib, stores, hooks or api modules, or when a CI run reports failing tests or zero-coverage changed files.
---

# 白盒单测 (White-box Testing)

「白盒」= 照着**实现里的分支结构**写用例,而不是照着函数名猜行为。
每个 `describe` 对应源码里一条可执行路径:try 成功分支 / catch 兜底分支 /
默认参数 / 边界值 / 早退条件。

参考样例:`src/utils/__tests__/formatCurrencyAmount.test.ts` —— 它的文件头注释
就记了一个典型的"看名字想当然会错"的点(`decimal.js` 原生支持 `NaN`,
所以 `toDecimalPlaces(NaN)` 走的是成功分支不是 catch)。这类事实只能读实现拿到,
正是白盒的价值。

## 快速上手

```bash
pnpm whitebox          # 跑全量 + 覆盖率 + 打印汇总报告(最常用)
pnpm whitebox:report   # 只重新渲染上一次的报告,不重跑测试
pnpm test:unit         # watch 模式,写用例时用
pnpm test:unit:run     # 只跑测试,不要覆盖率与报告
```

`pnpm whitebox` 即使测试挂了也会打印报告,并保留 vitest 的退出码。

## 三种报告格式

汇总逻辑收敛在 `scripts/whitebox-report.ts`,本地与 CI 共用同一份:

| 格式 | 用途 |
|---|---|
| `--format=markdown`(默认) | 人读:终端 / job summary,含覆盖率表与改动文件覆盖情况 |
| `--format=json` | 机读:CI 写进 `GITHUB_OUTPUT`,飞书卡片取数 |
| `--format=ai` | **喂给评审模型**:只保留失败原因 + 本次改动里的零覆盖文件 |

带上 `BASE_SHA` / `HEAD_SHA` 才会出现「本次改动文件的覆盖情况」这一节:

```bash
BASE_SHA=main HEAD_SHA=HEAD pnpm whitebox:report -- --format=ai
```

## 测试范围与覆盖率口径

`vitest.config.ts` 的 `coverage.include` 只统计**逻辑层**:

```
src/utils/**  src/lib/**  src/stores/**  src/hooks/**  src/api/*.ts
```

UI 渲染层(`components` / `features` / `routes` / `layouts`)**刻意不计入** ——
混进来会把基线稀释成无意义的数字。要测 UI 交互走 `webapp-testing` skill(Playwright)。

排除项:`src/api/__generated__/`(orval 生成)、`src/solana/`(codama 生成)、
`src/routeTree.gen.ts`(TanStack Router 生成)。生成物不写测试。

## 写用例的约定

- **不开 `globals`**。显式 `import { describe, it, expect, vi } from 'vitest'`,
  这样 `pnpm typecheck` 不必往 tsconfig 里塞 `vitest/globals`。
- 路径别名 `@/` 与 `~/` 都指向 `src/`,和 `vite.config.ts` 一致。
- 文件位置:`src/<模块>/__tests__/<被测文件名>.test.ts`。
- 环境:jsdom。`import.meta.env.MODE === 'test'`,所以 `IS_PRODUCTION` 和
  `IS_DEVELOPMENT` **都是 false**。要测另一个分支:`vi.stubEnv('MODE', 'production')`
  \+ `vi.resetModules()` 重新导入被测模块。

现成的 harness(用法写在各文件头部注释里,直接读那里):

| 文件 | 挡住什么 |
|---|---|
| `src/test/mocks/privy.ts` | `@privy-io/react-auth` 全家桶(jsdom 下跑不了真的 auth) |
| `src/test/mocks/solana.ts` | 只挡网络边界:`Connection` 与 rpc subscriptions,纯计算不挡 |
| `src/test/mocks/store2.ts` | `store2` 换成 Map 替身,避免用例间通过 localStorage 互相污染 |
| `src/test/renderHookWithProviders.tsx` | 带 QueryClientProvider 的 `renderHook` / `render` |

`vi.mock` 必须写在测试文件**顶层**才会被提升。

全局 setup 在 `src/test/setup.ts`:补了 `matchMedia` / `ResizeObserver` /
`IntersectionObserver` / `scrollTo`,每个用例前清 storage、后 `cleanup()`。

## CI:测试结果如何进到 AI 代码评审

`.github/workflows/unified-ci.yml` 里这条链是**串行**的,顺序有意为之:

```
whitebox-test  →  push-code-review  →  report-feishu
  真的执行代码      LLM 读 diff + 测试结果      合成一张飞书卡
```

`whitebox-test` 把 `--format=ai` 的输出上传成 artifact
(`whitebox-ai-context-<run_id>`),`push-code-review` 下载后作为
`# 白盒测试结果(实测,非推断)` 段落插进 prompt,并在 system prompt 里要求模型:

- 有失败用例 → 当最高优先级线索,顺着失败信息在 diff 里定位成因
- 本次改动文件被标为「零覆盖」→ 评审更严格,并点名该补什么用例
- 全绿也不等于没问题(覆盖率只覆盖逻辑层)

评审输出里因此多了一节 **🧪 测试视角**。

拿不到 artifact 时 prompt 会明写「未运行 / 结果未取回,不要假设代码有测试保护」,
而不是静默当作全绿 —— 这点别改掉。

## 手动触发 CI

Actions → **Unified CI Pipeline** → Run workflow,或:

```bash
gh workflow run unified-ci.yml --ref <branch> \
  -f base_ref=main \
  -f run_ai_review=true \
  -f notify_feishu=true
```

| 输入 | 说明 |
|---|---|
| `base_ref` | 对比基线(branch / tag / SHA)。留空 = 与默认分支的 merge-base |
| `run_ai_review` | 关掉可以只跑测试不烧 token |
| `notify_feishu` | 关掉则只出 job summary,不发卡 |

手动触发**只跑**上面那条链,不跑 bundle diff / tsc diff 那些重活;
concurrency 分组是 `manual-<run_id>`,既不会被后续 push 取消,也不会去取消正在跑的 push。

仓库变量开关:

| 变量 | 作用 |
|---|---|
| `ENABLE_WHITEBOX_TEST=false` | 关掉白盒测试 job(评审仍会跑,prompt 里会注明没测试) |
| `ENABLE_PUSH_CODE_REVIEW=false` | 关掉 AI 评审 job |
| `WHITEBOX_FAIL_ON_ERROR=true` | 测试失败即阻断 CI(默认只报告不阻断) |

## 补测试时的优先级

按「改动频率 × 当前覆盖率」排,先看 `pnpm whitebox` 报告里
**「本次改动文件的覆盖情况」**中标 ⚠️ 的零覆盖文件 —— 那是刚被改过、
却完全没有测试兜底的代码,风险最高。

纯函数(`utils` / `lib`)优先于带副作用的(`stores` / `hooks`):投入产出比高,
且不需要 harness。

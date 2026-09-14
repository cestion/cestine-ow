---
name: business-analysis
description: Analyze the whole codebase from a business/product angle — what the product does, what business rules are hard-coded, where the business risks are. Use when asked to 业务分析 / 全量代码分析 / 业务全景 / 产品能力地图 / 业务规则 / 业务风险, when onboarding onto an unfamiliar domain under src/features, or when someone asks "这个产品到底在做什么" rather than "这次改动写得好不好".
---

# 业务全景分析 (Business Analysis)

和 `push-code-review` 是**两种视角**,并存而非替代:

| | 看什么 | 回答什么 | 什么时候跑 |
|---|---|---|---|
| `push-code-review` | `git diff` | 这次改动写得好不好 | 每次 push |
| `business-analysis` | **全量代码** | 这产品在做什么生意、业务规则是什么、哪里有业务风险 | **只手动触发** |

只看 diff 永远得不到第二类答案 —— 费率、阈值、状态机、鉴权边界都写在没被改动的
文件里。反过来,全量分析约 **26 次 LLM 调用 / 45 万输入 token**,挂到每次 push 上
是不可接受的开销。所以两条链分开,各跑各的。

## 为什么要先做确定性提取

一方源码 3.75 MB ≈ 100 万 token,丢不进任何模型。但「这个产品在做什么」并不需要
全部源码,它高度集中在几处**人写的语义**里:

- 路由的 SEO `title` / `description` —— 产品对用户的自我介绍
- orval 从 OpenAPI 生成的 `@summary` —— 后端写的中文接口说明,还带 `[鉴权]` / `@deprecated`
- `t('中文原文')` —— i18n 的 key 就是中文原文,用户真正读到的字,白捡的业务语义
- `src/features/*` —— 天然的业务域切分
- zustand store 的 state 字段 —— 跨域共享的业务状态

`scripts/business-map.ts` 负责把这些抽出来(纯正则,不联网不调模型),全局骨架只剩
**约 30 KB**。`scripts/business-analysis.ts` 负责喂给模型。

## 快速上手

```bash
# 只看提取结果,不烧 token —— 先用这个确认取材对不对
pnpm business:map                                  # markdown,人读
pnpm business:map -- --format=panorama             # 全局骨架(Stage 1 的 prompt)
pnpm business:map -- --format=domain --domain=income
pnpm business:map -- --format=json | jq '.domains | length'   # 24

# 真跑分析(要 key)
MINIMAX_KEY_BLOB=... pnpm business:analyze -- --domains=income --out=business-analysis
```

`business-analysis/` 已在 `.gitignore` 里。

## 四种提取格式

| 格式 | 产出 | 用途 |
|---|---|---|
| `--format=panorama` | 全局骨架 ≈ 30 KB | Stage 1 的 prompt |
| `--format=domain --domain=play` | 单域档案 | Stage 2 的 prompt |
| `--format=json` | 域清单 + 各域体量 | 编排脚本枚举域用 |
| `--format=markdown`(默认) | 人读版 | 本地看 |

单域档案的构成(按这个顺序):域概况 → 挂载它的路由(带 SEO 文案与鉴权守卫)→
它调用的接口(带 `@summary`)→ 它读写的全局 store 字段 → 用户可见文案 →
**逻辑层 `.ts` 源码全文** → UI 层 `.tsx` 只给文件名 + 导出组件名。

UI 层不给函数体是有意的:业务规则集中在逻辑层,`play` 的 UI 层单独就 585 KB,
给了也只是把预算烧在 JSX 上。

逻辑层全文有 `MAX_DOMAIN_SOURCE_BYTES = 150_000` 封顶。超限时按
`*Store.ts` → `*Policy.ts` → `*Api.ts` → `hooks/` → `constants`/`config` → 其余 → `types/`
的优先级保留(业务规则密度从高到低),并在档案末尾**列出被丢掉的文件名**。
目前只有 `play` 会触发截断。

`scripts/business-map.ts` 里所有 `MAX_*` 常量是下游 prompt 的成本闸门,别顺手去掉。

## 三段式链路

```
Stage 1 全景   panorama 骨架(~30KB)        → 1 次调用
                  ↓ 产品能力地图 / 核心业务流程 / 域优先级 / 骨架疑点
Stage 2 逐域   每域档案 + Stage 1 作为共享上下文 → N 次调用(默认并发 3)
                  ↓ 每域:在做什么 / 业务规则与约束 / 业务风险 / 该补什么测试
Stage 3 汇总   各域结论(各截断 1800 字)+ 全景 → 1 次调用
                  ↓ 跨域链路 / 跨域规则冲突 / 全局风险 Top 5 / 下一步建议
```

Stage 1 的结论会塞进每个 Stage 2 的 prompt —— 让模型知道本域在整体中的位置,
否则它会把 `income` 当成一个孤立的收益页,看不出它是挖矿结算链路的末端。

**单域失败不阻断整轮**:该域记 error,其余照常跑完,Stage 3 只汇总成功的,
`report.md` 顶部会写明哪些域缺失。脚本用非零退出码收尾,但报告已经写出来了。

参数:

| 参数 | 默认 | 说明 |
|---|---|---|
| `--domains=play,income` | 空 = 全部 24 个 | **省钱阀门**,只跑核心域成本降到约 1/4 |
| `--out=<dir>` | `/tmp/business` | 产出目录 |
| `--concurrency=N` | `3` | Stage 2 并发 |
| `--tests=<file>` | `/tmp/whitebox/ai-context.md` | 白盒测试现状,取不到就跳过 |

产出:`panorama.md`、`domains/<name>.md`、`synthesis.md`、`report.md`(合并版)、
`summary.json`(机读,CI 的飞书卡从这里取数)。

## 覆盖率口径:prompt 里必须明写的那条

`vitest.config.ts` 的 `coverage.include` **刻意不含 `src/features/**`**,只统计
`utils` / `lib` / `stores` / `hooks` / `api`。所以业务域根本没有覆盖率数字可言。

三个 stage 的 system prompt 里都带了 `MEASUREMENT_CAVEAT` 这段口径说明。
**别删掉它** —— 否则模型会把「features 覆盖率 0%」误读成一次回归,写出一堆
"覆盖率严重下滑"的假结论,而事实是它从来就不在统计范围内。

同理,档案里「有测试」一列只表示该域下**是否存在任何** `*.test.ts(x)`,
目前全仓只有 1 个测试文件,24 个域全是 `false`。

## 哪些域最值得先看

按「接口数 × 逻辑层体量」排,前几名就是业务规则最密的地方:

| 域 | 接口 | 逻辑层 | 为什么值得先看 |
|---|---:|---:|---|
| `play` | 27 | 203 KB | 播放 + 挖矿主链路,唯一会触发源码截断的域 |
| `game` | 15 | 49 KB | 玩法与奖励规则 |
| `profile` | 12 | 33 KB | 账户、资产、身份 |
| `1011` | 12 | 29 KB | 活动玩法,规则最容易写死在代码里 |
| `drama-flow` | 5 | 35 KB | 创作流程状态机,**没有路由挂载**,被别的域嵌入使用 |
| `income` | 4 | 16 KB | 结算与提现,金额精度风险最高;小到能人工通读,适合当校对基准 |

`mining` 域接口数为 0 是**正确的** —— 它只 import 了一个 model 类型,实际调用
落在 `play` 里。这类「名字和职责对不上」的地方正是 Stage 1「骨架疑点」要抓的。

先跑一遍 `--domains=income` 做端到端验证:它只有 4 个接口、11 条文案,
输出能一眼看出模型有没有在编。

## 手动触发 CI

```bash
gh workflow run unified-ci.yml --ref <branch> \
  -f run_ai_review=false \
  -f notify_feishu=true \
  -f run_business_analysis=true \
  -f business_domains=income,mining
```

| 输入 | 默认 | 说明 |
|---|---|---|
| `run_business_analysis` | **false** | 贵,默认关 |
| `business_domains` | 空 | 留空 = 全部 24 个域;填域名可省钱 |

`business-analysis` job 的硬边界:`github.event_name == 'workflow_dispatch'`,
**push 事件永远不触发**。这是「并存」的底线,别为了省事把它挂到 push 上。

`needs: whitebox-test` 只为拿测试现状当上下文,配 `!cancelled()` ——
白盒测试被开关关掉时是 `skipped`,业务分析不该跟着跳。artifact 下载步骤是
`continue-on-error`,取不到脚本会自己走「本次未取到白盒单测结果」分支。

结果去向:job summary(完整 `report.md`)+ artifact `business-analysis-<run_id>`
(保留 30 天)+ 一张**独立的紫色飞书卡**(只放 `synthesis.md` 的跨域结论)。

卡是独立发的,没有去改 `report-feishu`。那张卡的语义是「代码评审 + 白盒测试」,
塞进第三块内容会冲淡它;而且它的 `needs` 一旦加上本 job,push 事件的卡也要跟着
改判空逻辑。

仓库变量开关:

| 变量 | 作用 |
|---|---|
| `ENABLE_BUSINESS_ANALYSIS=false` | 关掉整个 job |
| `BUSINESS_ANALYSIS_MODEL` | 业务分析模型(默认回落 `PUSH_REVIEW_MODEL`,再回落 `MiniMax-M3`) |
| `BUSINESS_CONCURRENCY` | Stage 2 并发数(默认 3) |

## 成本

| 阶段 | 调用 | 输入 | 输出 |
|---|---:|---:|---:|
| Stage 1 全景 | 1 | ~20 K | ~3 K |
| Stage 2 逐域 | 24 | ~384 K(`play` 单域约 70 K) | ~48 K |
| Stage 3 汇总 | 1 | ~40 K | ~4 K |
| **合计** | **26** | **~450 K** | **~55 K** |

只跑 `play,game,mining,income,drama-flow` 这 5 个核心域降到约 1/4。

## 改这套东西时的注意事项

- `scripts/business-map.ts` 里的 `EXCLUDED` 是从 `scripts/pr-impact-analysis.ts`
  **复制**的,不是 import —— 那个文件顶层就 `console.log` + `process.exit`,
  import 会有副作用。改排除规则时两边要一起改。
- `scripts/lib/llm.ts` 的选路(MiniMax 优先,回落 `ANTHROPIC_API_KEY`)和
  `unified-ci.yml` 里 `push-code-review` 那段 bash 是**两份实现**。那段 bash 在跑、
  已验证,刻意没动它。改选路逻辑时两边一起改。
- 飞书卡片的 shell 里拼多行**一律用 `printf`**,不要写字面换行的赋值 ——
  `run: |` 是块标量,续行一旦顶到第 1 列就会提前终止块,整个 workflow 解析失败。
  改完用 `node -e "require('yaml').parse(...)"` 先本地验一遍。

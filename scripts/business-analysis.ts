#!/usr/bin/env tsx
/**
 * Business Analysis — 从业务/产品角度分析全量代码
 *
 * 与 `push-code-review`(读 diff 做代码质量评审)是两种视角,并存而非替代:
 * 那条链回答「这次改动写得好不好」,这条链回答「这个产品在做什么、
 * 业务规则是什么、哪里有业务风险」。后者只看 diff 永远得不到。
 *
 * 三段式:
 *
 *   Stage 1 全景   business-map 的骨架(~30KB)      → 1 次调用
 *   Stage 2 逐域   每域档案 + Stage 1 作为共享上下文 → N 次调用(默认并发 3)
 *   Stage 3 汇总   各域结论摘要 + 全景               → 1 次调用
 *
 * 取材全部来自 scripts/business-map.ts 的确定性提取 —— 模型看到的是代码里
 * 真实存在的路由/接口/规则,不是它对着目录名的想象。
 *
 * 用法:
 *   tsx scripts/business-analysis.ts                          # 全部 24 个域
 *   tsx scripts/business-analysis.ts --domains=income,mining   # 只跑指定域(省钱)
 *   tsx scripts/business-analysis.ts --out=/tmp/business --concurrency=3
 *
 * 产出:<out>/panorama.md, <out>/domains/<name>.md, <out>/report.md, <out>/summary.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type BusinessMap,
  buildBusinessMap,
  renderDomainOf,
  renderPanoramaOf,
} from './business-map';
import { callLlm, type LlmConfig, LlmUnavailableError, resolveLlm } from './lib/llm';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const OUT_DIR = resolve(process.cwd(), argOf('out') ?? '/tmp/business');
const CONCURRENCY = Math.max(1, Number(argOf('concurrency') ?? 3));
const REQUESTED_DOMAINS = (argOf('domains') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** 汇总阶段每份域报告的截断长度 —— 24 份不截断会把 Stage 3 撑爆。 */
const MAX_DOMAIN_DIGEST_CHARS = 1800;
/** 白盒测试上下文(CI 里由 whitebox-test 的 artifact 提供) */
const TEST_CONTEXT_FILE = argOf('tests') ?? '/tmp/whitebox/ai-context.md';

const log = (msg: string) => process.stderr.write(`${msg}\n`);

// ---------------------------------------------------------------------------
// 共用的口径说明 —— 三个阶段都要带上,否则模型会误读「覆盖率 0%」
// ---------------------------------------------------------------------------

const MEASUREMENT_CAVEAT = `
测量口径(别误读):
- 所有路由 / 接口 / 业务域 / 状态字段都是从代码里确定性提取的,不是推断。\`@summary\` 是后端在 OpenAPI 里写的业务说明,🔒 表示该接口要求登录。
- 「有测试」一列指该业务域下是否存在任何 \`*.test.ts(x)\`。本仓 \`vitest.config.ts\` 的 coverage 范围**刻意不含 \`src/features/**\`**(只统计 utils/lib/stores/hooks/api 这些逻辑层),所以业务域没有覆盖率数字可言 —— 不要把这解读成「覆盖率下降」,它从来就不在统计范围内。
- UI 层(\`.tsx\`)只给了文件名与导出组件名,没给函数体。业务规则集中在逻辑层(\`.ts\`),那部分是全文。
`.trim();

// ---------------------------------------------------------------------------
// Stage 1:全景
// ---------------------------------------------------------------------------

const PANORAMA_SYSTEM = `
你是资深产品架构师,正在接手一个陌生的代码库。你拿到的是从全量代码里确定性提取出来的**业务骨架**:路由地图(含面向用户的 SEO 文案)、后端接口清单(含中文业务说明)、业务域清单、全局状态字段。

你的任务不是评价代码质量,而是回答:**这个产品在做什么生意,它的业务是怎么运转的。**

${MEASUREMENT_CAVEAT}

输出中文 Markdown,严格按以下四节:

## 🗺️ 产品能力地图
这个产品对用户承诺了哪些能力?按用户视角分组(不是按代码目录分组),每组一句话说清楚"用户能做什么"。控制在 8 组以内。

## 🔀 核心业务流程
把关键链路端到端串起来,每条流程写成 \`A → B → C\` 的形式,并标注每一步落在哪个业务域、调用哪个接口。只写你能从路由与接口里**证实**的流程,证据不足就标"(推测,证据不足)"。最多 5 条。

## 📊 业务域优先级
按"业务重要性 × 复杂度"给业务域排序,列出最该深入分析的前 8 个,每个一句话说明理由。这份排序会用于后续的逐域深挖。

## ❓ 骨架层面的疑点
只看骨架就能看出的可疑之处:命名与职责不符、接口已废弃但仍在用、路由守卫不一致、状态字段语义重叠等。最多 6 条,没有就写"无"。

要求:用反引号包住路由、接口、域名、字段名。不要复述骨架内容,要给出判断。控制在 1200 字内。
`.trim();

async function runPanorama(cfg: LlmConfig, map: BusinessMap): Promise<string> {
  const skeleton = renderPanoramaOf(map);
  const tests = existsSync(TEST_CONTEXT_FILE)
    ? readFileSync(TEST_CONTEXT_FILE, 'utf8').trim()
    : '本次未取到白盒单测结果。';

  log(`[Stage 1] 全景分析,骨架 ${(skeleton.length / 1024).toFixed(1)}KB`);
  return callLlm(cfg, {
    system: PANORAMA_SYSTEM,
    user: `${skeleton}\n\n# 白盒单测现状(实测)\n${tests}`,
    maxTokens: 4000,
  });
}

// ---------------------------------------------------------------------------
// Stage 2:逐域深挖
// ---------------------------------------------------------------------------

const DOMAIN_SYSTEM = `
你是资深产品架构师,正在深入分析一个业务域。你拿到的是该域的完整档案:挂载它的路由、它调用的接口(含后端写的中文业务说明)、它读写的全局状态、用户在界面上读到的文案,以及**逻辑层源码全文**。

你的任务不是做代码审查,而是把这个域的**业务规则**从代码里读出来、讲清楚。

${MEASUREMENT_CAVEAT}

输出中文 Markdown,严格按以下四节:

## 🎯 这个域在做什么
两三句话。站在用户角度,不要用"管理""处理"这类空话。

## 📜 业务规则与约束
从源码里**实际读到**的规则,每条必须给出证据(文件名 + 常量名/函数名)。重点找:
- 写死的数值:费率、分成比例、阈值、上限、冷却时间、分页大小、精度位数
- 状态机:一个对象有哪些状态、允许的流转、谁能触发
- 权限边界:哪些操作要登录、要什么身份、前端在哪里拦
- 时间与计价:结算周期、释放曲线、货币单位与小数位

找不到就写"未发现",不要编。最多 12 条。

## ⚠️ 业务风险
从业务后果出发,不是代码风格。每条写成「现象 → 业务后果」。重点找:
- 金额/精度:截断方向、单位换算、浮点、显示与实际不一致
- 规则不一致:同一业务概念在不同文件里用了不同阈值或算法
- 边界未处理:空态、超时、并发重复提交、失败后的资金/状态残留
- 鉴权缺口:敏感操作只在前端拦
按严重度排序,最多 6 条。没有就写"未发现明显业务风险"。

## 🧪 最该补测试的地方
结合上面找到的规则,点名 3 个最该补单测的函数(文件 + 函数名),并说明"如果它错了,用户会遇到什么"。

要求:引用具体文件名与符号名,用反引号包起来。不要贴大段源码。控制在 900 字内。
`.trim();

async function runDomain(
  cfg: LlmConfig,
  map: BusinessMap,
  name: string,
  panorama: string,
): Promise<string> {
  const dossier = renderDomainOf(map, name);
  if (dossier === null) throw new Error(`未知业务域 ${name}`);

  return callLlm(cfg, {
    system: DOMAIN_SYSTEM,
    user: `# 全局业务全景(供你理解本域在整体中的位置)\n${panorama}\n\n---\n\n${dossier}`,
    maxTokens: 3000,
  });
}

// ---------------------------------------------------------------------------
// Stage 3:汇总
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM = `
你是资深产品架构师。你已经拿到了全局业务全景,以及每个业务域各自的分析结论。现在做跨域收口 —— 单看一个域看不出来、必须放在一起才浮现的问题。

${MEASUREMENT_CAVEAT}

输出中文 Markdown,严格按以下五节:

## 💡 一句话讲清这个产品
一句话。如果要向没接触过的人介绍这个产品,你会怎么说。

## 🔗 跨域业务链路
把各域的结论拼成完整链路,指出交接点在哪、谁持有状态、哪一步最脆弱。最多 4 条。

## ⚡ 跨域规则冲突
同一业务概念在不同域里口径不一致的地方(阈值不同、精度不同、状态定义不同、同一个字段被两个域按不同语义写入)。每条要点名涉及哪些域。最多 6 条,没有就写"未发现"。

## 🚨 全局业务风险 Top 5
把各域的风险合并去重,按"影响用户数 × 损失不可逆程度"排序。资金相关的风险优先。每条给出:风险、涉及域、建议动作。

## 🧭 下一步建议
按投入产出比排序,最多 5 条可落地的动作。测试相关的建议要具体到文件与函数。

要求:控制在 1200 字内。不要复述各域已经说过的内容,只写跨域才看得见的结论。
`.trim();

async function runSynthesis(
  cfg: LlmConfig,
  panorama: string,
  reports: { name: string; text: string }[],
): Promise<string> {
  const digest = reports
    .map(
      ({ name, text }) =>
        `## 业务域:${name}\n${
          text.length > MAX_DOMAIN_DIGEST_CHARS
            ? `${text.slice(0, MAX_DOMAIN_DIGEST_CHARS)}…`
            : text
        }`,
    )
    .join('\n\n---\n\n');

  log(`[Stage 3] 汇总 ${reports.length} 份域报告`);
  return callLlm(cfg, {
    system: SYNTHESIS_SYSTEM,
    user: `# 全局业务全景\n${panorama}\n\n---\n\n# 各业务域分析结论\n${digest}`,
    maxTokens: 4000,
  });
}

// ---------------------------------------------------------------------------
// 并发
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let cfg: LlmConfig;
  try {
    cfg = resolveLlm();
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      log(`✗ ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  log(`模型:${cfg.model}(${cfg.provider})`);

  const map = buildBusinessMap();
  const all = map.domains.map((d) => d.name);

  const unknown = REQUESTED_DOMAINS.filter((d) => !all.includes(d));
  if (unknown.length) {
    log(`✗ 未知业务域:${unknown.join(', ')}\n  可选:${all.join(', ')}`);
    process.exit(2);
  }
  // 不指定就全跑,按逻辑层体量从大到小 —— 大域先出结果,失败也能早发现
  const targets = REQUESTED_DOMAINS.length ? REQUESTED_DOMAINS : all;

  mkdirSync(resolve(OUT_DIR, 'domains'), { recursive: true });

  const panorama = await runPanorama(cfg, map);
  writeFileSync(resolve(OUT_DIR, 'panorama.md'), panorama, 'utf8');

  log(`[Stage 2] 逐域深挖 ${targets.length} 个域,并发 ${CONCURRENCY}`);
  let done = 0;
  const outcomes = await mapWithConcurrency(targets, CONCURRENCY, async (name) => {
    try {
      const text = await runDomain(cfg, map, name, panorama);
      writeFileSync(resolve(OUT_DIR, 'domains', `${name}.md`), text, 'utf8');
      log(`  ✓ ${++done}/${targets.length} ${name}`);
      return { name, text, error: null as string | null };
    } catch (err) {
      const message = (err as Error).message;
      // 单个域挂掉不该让整轮白跑 —— 记下来,剩下的照常跑完
      log(`  ✗ ${++done}/${targets.length} ${name}:${message}`);
      return { name, text: '', error: message };
    }
  });

  const ok = outcomes.filter((o) => !o.error);
  const failed = outcomes.filter((o) => o.error);

  const synthesis = ok.length
    ? await runSynthesis(cfg, panorama, ok)
    : '_所有业务域分析均失败,无法汇总。_';
  writeFileSync(resolve(OUT_DIR, 'synthesis.md'), synthesis, 'utf8');

  // ---- 合并报告 ----
  const report: string[] = [];
  report.push('# 📊 业务全景分析(全量代码)');
  report.push('');
  report.push(
    `模型 \`${cfg.model}\` · 路由 ${map.routes.length} 条 · 接口 ${map.operations.length} 个 · 业务域 ${targets.length}/${all.length} 个`,
  );
  report.push('');
  if (failed.length) {
    report.push(
      `> ⚠️ ${failed.length} 个业务域分析失败,下方结论不含它们:${failed
        .map((f) => `\`${f.name}\``)
        .join(', ')}`,
    );
    report.push('');
  }
  report.push('---');
  report.push('');
  report.push(synthesis);
  report.push('');
  report.push('---');
  report.push('');
  report.push('# 🗺️ 业务全景');
  report.push('');
  report.push(panorama);
  report.push('');
  report.push('---');
  report.push('');
  report.push('# 🔬 各业务域详细分析');
  report.push('');
  for (const { name, text } of ok) {
    report.push(`<details><summary><b>${name}</b></summary>`);
    report.push('');
    report.push(text);
    report.push('');
    report.push('</details>');
    report.push('');
  }
  writeFileSync(resolve(OUT_DIR, 'report.md'), report.join('\n'), 'utf8');

  writeFileSync(
    resolve(OUT_DIR, 'summary.json'),
    JSON.stringify(
      {
        model: cfg.model,
        provider: cfg.provider,
        routes: map.routes.length,
        operations: map.operations.length,
        domainsTotal: all.length,
        domainsAnalyzed: ok.length,
        domainsFailed: failed.map((f) => ({ name: f.name, error: f.error })),
        llmCalls: 1 + targets.length + (ok.length ? 1 : 0),
      },
      null,
      2,
    ),
    'utf8',
  );

  log(`\n完成。产出在 ${OUT_DIR}/`);
  // 有域失败时用非零退出码,让 CI 的 step 标黄,但报告已经写出来了
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  log(`✗ ${(err as Error).message}`);
  process.exit(1);
});

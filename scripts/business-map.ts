#!/usr/bin/env tsx
/**
 * Business Map — 确定性业务骨架提取器(不联网,不调模型)
 *
 * 全量一方源码约 3.75 MB(≈100 万 token),没法整个丢给模型。但「这个产品在做什么」
 * 并不需要全部源码 —— 它高度集中在几处人写的语义里:
 *
 *   - 路由的 SEO title/description(产品对用户的自我介绍)
 *   - orval 从 OpenAPI 生成的 `@summary`(后端写的接口业务说明,还带 [鉴权]/@deprecated)
 *   - `t('中文原文')`(用户在界面上真正读到的字)
 *   - features 目录树(天然的业务域切分)
 *   - zustand store 的 state 字段(跨域共享的业务状态)
 *
 * 把这些抽出来,全局骨架只有几十 KB。本脚本负责抽,`business-analysis.ts` 负责喂给模型。
 *
 * 用法:
 *   tsx scripts/business-map.ts --format=panorama            # 全局骨架 → Stage 1 prompt
 *   tsx scripts/business-map.ts --format=domain --domain=play # 单域档案 → Stage 2 prompt
 *   tsx scripts/business-map.ts --format=json                 # 机读:域清单与体量
 *   tsx scripts/business-map.ts                               # markdown,人读
 *
 * 设计约束:所有列表都有 MAX_* 上限。这是下游 prompt 的成本闸门,别去掉。
 */

import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const SRC = resolve(ROOT, 'src');
const ROUTES_DIR = resolve(SRC, 'routes');
const FEATURES_DIR = resolve(SRC, 'features');
const STORES_DIR = resolve(SRC, 'stores');
const GENERATED_API_DIR = resolve(SRC, 'api/__generated__');

// ---------------------------------------------------------------------------
// 上限 —— 直接决定下游 prompt 的 token 成本
// ---------------------------------------------------------------------------

/** 单域档案里逻辑层源码的字节上限。play 域逻辑层就有 203 KB,必然触发截断。 */
const MAX_DOMAIN_SOURCE_BYTES = 150_000;
/** 全景里每个域展示几条代表性文案 */
const MAX_PANORAMA_TEXTS = 12;
/** 单域档案里的用户可见文案条数 */
const MAX_DOMAIN_TEXTS = 120;
/** 接口长描述的截断长度(只在单域档案里出现,全景只给 summary) */
const MAX_OP_DESCRIPTION_CHARS = 400;
/** 单域档案里列出的 UI 组件数 */
const MAX_DOMAIN_UI_FILES = 80;
/** 单个文件导出符号的展示数 */
const MAX_EXPORTS_PER_FILE = 12;

// ---------------------------------------------------------------------------
// 作用域 —— 与 scripts/pr-impact-analysis.ts 的 EXCLUDED 保持一致。
// 那个文件是可执行脚本(顶层就 console.log + process.exit),不能 import,
// 所以这里复制一份;改动时两边要一起改。
// ---------------------------------------------------------------------------

const EXCLUDED = [
  /^node_modules\//,
  /^dist\//,
  /^\.output\//,
  /^coverage\//,
  /^src\/api\/__generated__\//,
  /^src\/solana\//,
  /^src\/routeTree\.gen\.ts$/,
  /\.backup$/,
];

const isExcluded = (relPath: string) => EXCLUDED.some((re) => re.test(relPath));

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

type RouteInfo = {
  /** createFileRoute 里声明的真实 path,取不到时回落目录推断 */
  path: string;
  file: string;
  component: string;
  title: string;
  description: string;
  /** beforeLoad 的行为摘要:重定向目标 / 是否校验登录 */
  guard: string;
  searchParams: string[];
  /** 这条路由挂载了哪些业务域 */
  domains: string[];
};

type ApiOperation = {
  service: string;
  tag: string;
  name: string;
  method: string;
  url: string;
  summary: string;
  description: string;
  /** @summary 里带 [鉴权] 前缀 —— 后端标注的登录态要求 */
  auth: boolean;
  deprecated: boolean;
};

type DomainInfo = {
  name: string;
  fileCount: number;
  logicBytes: number;
  uiBytes: number;
  logicFiles: string[];
  uiFiles: string[];
  exports: Map<string, string[]>;
  /** 本域实际调用的接口名(已解析 use/get 包装) */
  operations: string[];
  routes: string[];
  stores: string[];
  texts: string[];
  hasTests: boolean;
};

type StoreInfo = {
  file: string;
  stateFields: string[];
};

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    const rel = relative(ROOT, full);
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function read(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function bytes(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function truncate(s: string, max: number): string {
  const clean = s.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function kb(n: number): string {
  return `${Math.round(n / 1024)}KB`;
}

/**
 * 从 `start` 处的 `{` 向后找配对的 `}`,返回块内容。
 * 只做括号计数,不处理字符串里的花括号 —— 对本文件要解析的 `beforeLoad` /
 * `validateSearch` / store state 声明足够了,拿不准就返回空串,调用方会优雅降级。
 *
 * `sameStatement` 用于类型声明:`type FooState = Bar;` 这种没有花括号的别名,
 * 不加约束会一路扫到文件后面某个无关的 `{`,把别人的字段当成 store 字段。
 */
function braceBlock(content: string, start: number, sameStatement = false): string {
  const open = content.indexOf('{', start);
  if (open < 0) return '';
  if (sameStatement && content.slice(start, open).includes(';')) return '';
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(open + 1, i);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// 1. 路由地图
// ---------------------------------------------------------------------------

/** 与 scripts/pr-impact-analysis.ts 的同名函数一致(见上方复制说明)。 */
function inferRouteFromRoutesDir(file: string): string {
  const rel = relative(ROUTES_DIR, file);
  if (rel.startsWith('..')) return '';
  const withoutExt = rel.replace(/\.(tsx?|jsx?)$/, '');
  if (withoutExt === '__root') return '/ (root)';
  if (withoutExt === 'index') return '/';
  const parts = withoutExt.split('/').filter((p) => p !== 'index');
  return `/${parts.join('/')}`;
}

/** 取 `key: '值'` / `key:\n  '值'`,三种引号都认。 */
function pickString(block: string, key: string): string {
  const re = new RegExp(`${key}\\s*:\\s*(?:\\n\\s*)?(['"\`])([\\s\\S]*?)\\1`);
  return block.match(re)?.[2]?.trim().replace(/\s+/g, ' ') ?? '';
}

/**
 * 路由的准入条件。它散落在两处,只看 `beforeLoad` 会漏掉一半:
 *   - `beforeLoad` 里:重定向、`guardDevOnlyRouteIfDisabled()` 这类开关守卫
 *   - component 里:`<AppLoginPromptGate>` 这类包住 Outlet 的登录门禁
 */
function summarizeGuard(content: string): string {
  const parts: string[] = [];

  const idx = content.indexOf('beforeLoad');
  if (idx >= 0) {
    const block = braceBlock(content, idx);
    const before = parts.length;

    const redirects = [...block.matchAll(/to:\s*'([^']+)'/g)].map((m) => m[1]);
    if (redirects.length) {
      parts.push(`重定向→${[...new Set(redirects)].join(' / ')}`);
    }
    // 守卫函数名本身就是业务语义,直接抄过来比归类成「有守卫」有用
    for (const m of block.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
      if (/guard|gate|require|ensure/i.test(m[1])) parts.push(`${m[1]}()`);
    }
    if (/isLogin|userToken|getIsLogin|authenticated/i.test(block)) {
      parts.push('校验登录态');
    }
    if (/throw\s+notFound/.test(block)) parts.push('可能 404');
    if (parts.length === before) parts.push('有 beforeLoad');
  }

  for (const m of content.matchAll(/<([A-Z][\w$]*(?:Gate|Guard))\b/g)) {
    parts.push(`<${m[1]}>`);
  }

  return [...new Set(parts)].join('; ');
}

function extractSearchParams(content: string): string[] {
  const idx = content.indexOf('validateSearch');
  if (idx < 0) return [];
  const block = braceBlock(content, idx);
  if (!block) return [];
  // 约定俗成的收尾:`return { autoplay, commentId, ... };`
  const ret = block.match(/return\s*\{([^}]*)\}/);
  if (!ret) return [];
  return ret[1]
    .split(',')
    .map((s) => s.split(':')[0].trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

function extractRoutes(): RouteInfo[] {
  const routes: RouteInfo[] = [];
  for (const file of walk(ROUTES_DIR).sort()) {
    const content = read(file);
    const rel = relative(ROOT, file);

    const declaredPath = content.match(/createFileRoute\(\s*'([^']*)'/)?.[1];
    const path = declaredPath || inferRouteFromRoutesDir(file);

    // seo({ title, description }) 是本仓统一的 head 写法
    const title = pickString(content, 'title');
    const description = pickString(content, 'description');

    const component =
      content.match(/component:\s*([A-Za-z_$][\w$]*)/)?.[1] ??
      (/component:\s*\(\)/.test(content) ? '(内联)' : '');

    const domains = [
      ...new Set(
        [...content.matchAll(/from\s*'@\/features\/([^/']+)/g)].map((m) => m[1]),
      ),
    ].sort();

    routes.push({
      path,
      file: rel,
      component,
      title,
      description,
      guard: summarizeGuard(content),
      searchParams: extractSearchParams(content),
      domains,
    });
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// 2. 接口清单(orval 生成物)
// ---------------------------------------------------------------------------

/**
 * 一个服务模块里的 operation 形如:
 *
 *   export const getListShareAttemptsUrl = (activityId: number) => {
 *     return `/api/activity/activities/${activityId}/shareAttempts`;
 *   };
 *
 *   /**
 *    * <长描述,可能多行>
 *    * @summary [鉴权]查询所有平台的分享 attempt 状态
 *    *\/
 *   export const listShareAttempts = async (…): Promise<…> => {
 *     return appAxiosInstance<…>(getListShareAttemptsUrl(activityId), {
 *       ...options, method: 'GET',
 *     });
 *   };
 *
 * 同一个 @summary 还会重复挂在 useXxx / useXxxSuspense 上,所以这里只认
 * `export const X = async (` 且函数体里调了 appAxiosInstance 的那一个,天然去重。
 */
function extractOperationsFromModule(
  service: string,
  tag: string,
  content: string,
): ApiOperation[] {
  // URL builder 有三种形状:无参直接 return、路径参数用 `${id}` 插值、
  // 查询参数版本 return 的是一个三元(带 ?query / 不带)。统一做法:取出函数体里
  // 所有以 / 开头的模板字符串,优先挑不含 ? 的那条裸路径。
  const urlByOp = new Map<string, string>();
  for (const m of content.matchAll(/export const get(\w+)Url = \(/g)) {
    const arrow = content.indexOf('=>', m.index ?? 0);
    if (arrow < 0) continue;
    const body = braceBlock(content, arrow);
    const literals = [...body.matchAll(/`(\/[^`]*)`/g)].map((x) => x[1]);
    if (!literals.length) continue;
    urlByOp.set(lowerFirst(m[1]), literals.find((l) => !l.includes('?')) ?? literals[0]);
  }

  const ops: ApiOperation[] = [];
  for (const m of content.matchAll(/export const (\w+) = async \(/g)) {
    const name = m[1];
    const idx = m.index ?? 0;
    const body = content.slice(idx, idx + 1500);
    if (!body.includes('appAxiosInstance')) continue;

    const method = body.match(/method:\s*'(\w+)'/)?.[1] ?? 'GET';

    // 紧邻上方的 JSDoc。必须是「紧邻」—— 否则会一路回溯到文件头那段
    // `Generated by orval` 的 banner,把它当成第一个接口的业务描述。
    let summary = '';
    let description = '';
    let deprecated = false;
    const before = content.slice(0, idx);
    const docStart = before.lastIndexOf('/**');
    if (docStart >= 0) {
      const docEnd = before.indexOf('*/', docStart);
      if (docEnd >= 0 && before.slice(docEnd + 2).trim() === '') {
        const raw = before.slice(docStart + 3, docEnd);
        if (!raw.includes('Generated by orval')) {
          const descLines: string[] = [];
          for (const line of raw.split('\n')) {
            const text = line.replace(/^\s*\*\s?/, '').trim();
            if (!text) continue;
            if (text.startsWith('@summary')) {
              summary = text.slice('@summary'.length).trim();
            } else if (text.startsWith('@deprecated')) {
              deprecated = true;
            } else if (!text.startsWith('@')) {
              descLines.push(text);
            }
          }
          description = descLines.join(' ');
        }
      }
    }

    ops.push({
      service,
      tag,
      name,
      method,
      // 保留字冲突时 orval 会把 operation 命名成 `_delete`,但 URL builder 仍叫
      // `getDeleteUrl` —— 去掉前导下划线再查一次。
      url: urlByOp.get(name) ?? urlByOp.get(name.replace(/^_/, '')) ?? '',
      // [鉴权] 只是标注,单独成列后从正文里摘掉,省 token
      summary: summary.replace(/^\[鉴权\]\s*/, ''),
      description,
      auth: summary.startsWith('[鉴权]'),
      deprecated,
    });
  }
  return ops;
}

function extractOperations(): ApiOperation[] {
  const ops: ApiOperation[] = [];
  let services: string[];
  try {
    services = readdirSync(GENERATED_API_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return ops;
  }

  for (const service of services.sort()) {
    const serviceDir = resolve(GENERATED_API_DIR, service);
    for (const entry of readdirSync(serviceDir, { withFileTypes: true })) {
      // model/ 只有类型声明,没有 operation
      if (!entry.isDirectory() || entry.name === 'model') continue;
      const tag = entry.name;
      const moduleFile = resolve(serviceDir, tag, `${tag}.ts`);
      const content = read(moduleFile);
      if (!content) continue;
      ops.push(...extractOperationsFromModule(service, tag, content));
    }
  }
  return ops;
}

/**
 * 业务代码 import 到的其实是 operation 的各种包装:
 *   listShareAttempts / useListShareAttempts / useListShareAttemptsSuspense /
 *   getListShareAttemptsUrl / getListShareAttemptsQueryKey / …
 * 这里把它们全部映射回 operation 名,好让「域 → 接口」绑定拿到的是业务语义。
 *
 * 响应类型(`<op>Response`)也算数:play 这类域不用 orval 的 hook,而是自己包一层
 * `appAxiosInstance` 再借用生成的响应类型 —— 只认 hook 名会把它们整片漏掉。
 */
function buildOperationAliases(ops: ApiOperation[]): Map<string, string> {
  const alias = new Map<string, string>();
  for (const op of ops) {
    const Pascal = op.name.charAt(0).toUpperCase() + op.name.slice(1);
    alias.set(op.name, op.name);
    for (const wrapper of [
      `use${Pascal}`,
      `use${Pascal}Suspense`,
      `use${Pascal}Mutation`,
      `get${Pascal}Url`,
      `get${Pascal}QueryKey`,
      `get${Pascal}QueryOptions`,
      `get${Pascal}SuspenseQueryOptions`,
      `get${Pascal}MutationOptions`,
      `${op.name}Response`,
      `${op.name}ResponseSuccess`,
      `${op.name}Response200`,
    ]) {
      alias.set(wrapper, op.name);
    }
  }
  return alias;
}

// ---------------------------------------------------------------------------
// 3. 全局状态
// ---------------------------------------------------------------------------

function extractStores(): StoreInfo[] {
  const stores: StoreInfo[] = [];
  for (const file of walk(STORES_DIR).sort()) {
    const content = read(file);
    // zustand store 的字段声明写在 `interface XState {}` / `type XState = {}` /
    // `type XState = BaseState & {}` 里。跨文件的交叉类型(如 createDramaStore 从
    // drama-flow 继承的 DramaFlowStoreState)这里不展开,那部分字段在对应域的源码里。
    const fields = new Set<string>();
    for (const m of content.matchAll(
      /(?:interface|type)\s+\w*(?:State|Store)\w*\s*(?:=|extends|\{)/g,
    )) {
      const block = braceBlock(content, m.index ?? 0, true);
      for (const line of block.split('\n')) {
        const field = line.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/);
        if (field) fields.add(field[1]);
      }
    }
    if (!fields.size) continue;
    stores.push({ file: relative(ROOT, file), stateFields: [...fields] });
  }
  return stores;
}

// ---------------------------------------------------------------------------
// 4. 业务域
// ---------------------------------------------------------------------------

function extractExports(content: string): string[] {
  const names = new Set<string>();
  for (const m of content.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/gm,
  )) {
    names.add(m[1]);
  }
  for (const m of content.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** `t('中文原文')` —— 本仓 i18n 的 key 就是中文源串,白捡的业务语义。 */
function extractTexts(content: string): string[] {
  const texts = new Set<string>();
  for (const m of content.matchAll(/\bt\(\s*(['"])([^'"]{1,120})\1/g)) {
    texts.add(m[2]);
  }
  return [...texts];
}

function extractDomains(
  routes: RouteInfo[],
  opAliases: Map<string, string>,
): DomainInfo[] {
  let names: string[];
  try {
    names = readdirSync(FEATURES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  return names.map((name) => {
    const dir = resolve(FEATURES_DIR, name);
    const files = walk(dir);

    const logicFiles: string[] = [];
    const uiFiles: string[] = [];
    let logicBytes = 0;
    let uiBytes = 0;
    let hasTests = false;

    const exports = new Map<string, string[]>();
    const operations = new Set<string>();
    const stores = new Set<string>();
    const texts = new Set<string>();

    for (const file of files.sort()) {
      const rel = relative(ROOT, file);
      if (/\.test\.tsx?$/.test(rel)) {
        hasTests = true;
        continue;
      }

      const size = bytes(file);
      if (rel.endsWith('.tsx')) {
        uiFiles.push(rel);
        uiBytes += size;
      } else {
        logicFiles.push(rel);
        logicBytes += size;
      }

      const content = read(file);
      const symbols = extractExports(content);
      if (symbols.length) exports.set(rel, symbols);

      // 域 → 接口:只认 __generated__ 的具名 import,model/ 里的类型不算调用
      for (const m of content.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@\/api\/__generated__\/([^']+)'/g,
      )) {
        if (m[2].includes('/model/')) continue;
        for (const raw of m[1].split(',')) {
          const symbol = raw.replace(/^\s*type\s+/, '').split(/\s+as\s+/)[0].trim();
          const op = opAliases.get(symbol);
          if (op) operations.add(op);
        }
      }

      for (const m of content.matchAll(/from\s*'@\/stores\/([^']+)'/g)) {
        stores.add(m[1]);
      }
      for (const text of extractTexts(content)) texts.add(text);
    }

    return {
      name,
      fileCount: logicFiles.length + uiFiles.length,
      logicBytes,
      uiBytes,
      logicFiles,
      uiFiles,
      exports,
      operations: [...operations].sort(),
      routes: routes.filter((r) => r.domains.includes(name)).map((r) => r.path),
      stores: [...stores].sort(),
      texts: [...texts],
      hasTests,
    };
  });
}

// ---------------------------------------------------------------------------
// 5. 渲染
// ---------------------------------------------------------------------------

/** SEO 文案里常见 `Earnings | StoryFun` 这种竖线,不转义会把表格列冲散。 */
const cell = (s: string) => s.replace(/\|/g, '\\|');

function renderRouteTable(routes: RouteInfo[]): string[] {
  const lines = ['| 路由 | 挂载 | 对外介绍 (SEO) | 守卫 | search 参数 |', '|---|---|---|---|---|'];
  for (const r of routes) {
    const seo = [r.title, r.description].filter(Boolean).join(' — ') || '—';
    lines.push(
      `| \`${r.path}\` | ${r.component || '—'} | ${cell(seo)} | ${
        cell(r.guard) || '—'
      } | ${r.searchParams.join(', ') || '—'} |`,
    );
  }
  return lines;
}

function renderApiSection(ops: ApiOperation[], detailed: boolean): string[] {
  const lines: string[] = [];
  const byGroup = new Map<string, ApiOperation[]>();
  for (const op of ops) {
    const key = `${op.service} / ${op.tag}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(op);
  }

  for (const [group, list] of [...byGroup.entries()].sort()) {
    lines.push(`**${group}**`);
    lines.push('');
    for (const op of list) {
      const flags = [op.auth ? '🔒' : '', op.deprecated ? '⚠️已废弃' : '']
        .filter(Boolean)
        .join(' ');
      lines.push(
        `- \`${op.method} ${op.url || '?'}\` — ${op.summary || op.name} ${flags}`.trimEnd(),
      );
      if (detailed && op.description) {
        lines.push(`  - ${truncate(op.description, MAX_OP_DESCRIPTION_CHARS)}`);
      }
    }
    lines.push('');
  }
  return lines;
}

function renderPanorama(
  routes: RouteInfo[],
  ops: ApiOperation[],
  domains: DomainInfo[],
  stores: StoreInfo[],
): string {
  const lines: string[] = [];

  lines.push('# 业务骨架(由代码确定性提取,非模型推断)');
  lines.push('');
  lines.push(
    `路由 ${routes.length} 条 · 接口 ${ops.length} 个(其中需登录 ${
      ops.filter((o) => o.auth).length
    } 个,已废弃 ${ops.filter((o) => o.deprecated).length} 个) · 业务域 ${
      domains.length
    } 个 · 全局 store ${stores.length} 个`,
  );
  lines.push('');

  lines.push('## 一、路由地图(SEO 文案是产品对用户的自我介绍)');
  lines.push('');
  lines.push(...renderRouteTable(routes));
  lines.push('');

  lines.push('## 二、全局状态(跨域共享的业务状态)');
  lines.push('');
  for (const s of stores) {
    lines.push(`- \`${s.file}\`:${s.stateFields.join(', ')}`);
  }
  lines.push('');

  lines.push('## 三、业务域');
  lines.push('');
  lines.push('| 域 | 文件 | 逻辑层 | UI 层 | 挂载路由 | 调用接口 | 有测试 |');
  lines.push('|---|---:|---:|---:|---|---:|---|');
  for (const d of [...domains].sort((a, b) => b.logicBytes - a.logicBytes)) {
    lines.push(
      `| \`${d.name}\` | ${d.fileCount} | ${kb(d.logicBytes)} | ${kb(d.uiBytes)} | ${
        d.routes.join(', ') || '—'
      } | ${d.operations.length} | ${d.hasTests ? '是' : '否'} |`,
    );
  }
  lines.push('');

  lines.push('各域的用户可见文案(节选,i18n key 即中文原文):');
  lines.push('');
  for (const d of domains) {
    if (!d.texts.length) continue;
    lines.push(`- **${d.name}**:${d.texts.slice(0, MAX_PANORAMA_TEXTS).join(' / ')}`);
  }
  lines.push('');

  lines.push('## 四、接口清单(`@summary` 为后端撰写的业务说明,🔒 = 需登录)');
  lines.push('');
  lines.push(...renderApiSection(ops, false));

  return lines.join('\n');
}

/** 业务规则密度从高到低 —— 截断时先丢密度低的。 */
function logicPriority(file: string): number {
  if (/Store\.ts$/.test(file)) return 0;
  if (/Policy\.ts$/.test(file)) return 1;
  if (/Api\.ts$/.test(file)) return 2;
  if (/\/hooks\//.test(file)) return 3;
  if (/(constants?|config)\.ts$/.test(file) || /\/constants?\//.test(file)) return 4;
  if (/\/types?\//.test(file) || /types?\.ts$/.test(file)) return 6;
  return 5;
}

function renderDomain(
  domain: DomainInfo,
  routes: RouteInfo[],
  ops: ApiOperation[],
  stores: StoreInfo[],
): string {
  const lines: string[] = [];
  const opByName = new Map(ops.map((o) => [o.name, o]));

  lines.push(`# 业务域:${domain.name}`);
  lines.push('');
  lines.push(
    `${domain.fileCount} 个文件 · 逻辑层 ${kb(domain.logicBytes)} · UI 层 ${kb(
      domain.uiBytes,
    )} · 测试:${domain.hasTests ? '有' : '**无**'}`,
  );
  lines.push('');

  lines.push('## 挂载它的路由');
  lines.push('');
  const own = routes.filter((r) => r.domains.includes(domain.name));
  if (own.length) {
    lines.push(...renderRouteTable(own));
  } else {
    lines.push('_没有路由直接挂载本域,它被其他域复用。_');
  }
  lines.push('');

  lines.push('## 它调用的接口');
  lines.push('');
  const used = domain.operations
    .map((name) => opByName.get(name))
    .filter((o): o is ApiOperation => Boolean(o));
  if (used.length) {
    lines.push(...renderApiSection(used, true));
  } else {
    lines.push('_不直接调用后端接口。_');
    lines.push('');
  }

  lines.push('## 它读写的全局状态');
  lines.push('');
  if (domain.stores.length) {
    for (const name of domain.stores) {
      const store = stores.find((s) => s.file.includes(`stores/${name}`));
      lines.push(
        `- \`@/stores/${name}\`${store ? `:${store.stateFields.join(', ')}` : ''}`,
      );
    }
  } else {
    lines.push('_不读写全局 store。_');
  }
  lines.push('');

  lines.push('## 用户在界面上读到的文案');
  lines.push('');
  lines.push(domain.texts.slice(0, MAX_DOMAIN_TEXTS).join(' / ') || '_无_');
  if (domain.texts.length > MAX_DOMAIN_TEXTS) {
    lines.push('');
    lines.push(`_…另有 ${domain.texts.length - MAX_DOMAIN_TEXTS} 条未列出_`);
  }
  lines.push('');

  lines.push('## UI 层(只给签名,业务规则不在这里)');
  lines.push('');
  for (const file of domain.uiFiles.slice(0, MAX_DOMAIN_UI_FILES)) {
    const symbols = (domain.exports.get(file) ?? []).slice(0, MAX_EXPORTS_PER_FILE);
    lines.push(`- \`${file}\`${symbols.length ? ` → ${symbols.join(', ')}` : ''}`);
  }
  if (domain.uiFiles.length > MAX_DOMAIN_UI_FILES) {
    lines.push(`- _…另有 ${domain.uiFiles.length - MAX_DOMAIN_UI_FILES} 个组件文件_`);
  }
  lines.push('');

  lines.push('## 逻辑层源码(业务规则在这里)');
  lines.push('');
  let used_bytes = 0;
  const skipped: string[] = [];
  for (const file of [...domain.logicFiles].sort(
    (a, b) => logicPriority(a) - logicPriority(b),
  )) {
    const content = read(file);
    if (used_bytes + content.length > MAX_DOMAIN_SOURCE_BYTES) {
      skipped.push(file);
      continue;
    }
    used_bytes += content.length;
    lines.push(`### \`${file}\``);
    lines.push('');
    lines.push('```ts');
    lines.push(content.trimEnd());
    lines.push('```');
    lines.push('');
  }
  if (skipped.length) {
    lines.push(
      `> ⚠️ 逻辑层超过 ${kb(MAX_DOMAIN_SOURCE_BYTES)} 上限,以下 ${
        skipped.length
      } 个文件未附源码(仅列文件名),分析时请注明这部分未覆盖:`,
    );
    lines.push('');
    for (const file of skipped) lines.push(`> - \`${file}\``);
    lines.push('');
  }

  return lines.join('\n');
}

function renderJson(
  routes: RouteInfo[],
  ops: ApiOperation[],
  domains: DomainInfo[],
  stores: StoreInfo[],
): string {
  return JSON.stringify(
    {
      routes: routes.length,
      operations: ops.length,
      operationsAuth: ops.filter((o) => o.auth).length,
      operationsDeprecated: ops.filter((o) => o.deprecated).length,
      stores: stores.length,
      domains: domains
        .map((d) => ({
          name: d.name,
          files: d.fileCount,
          logicBytes: d.logicBytes,
          uiBytes: d.uiBytes,
          routes: d.routes,
          operations: d.operations.length,
          texts: d.texts.length,
          hasTests: d.hasTests,
        }))
        // 逻辑层体量 = 业务规则密度的粗略代理,编排脚本按它排优先级
        .sort((a, b) => b.logicBytes - a.logicBytes),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 6. 对外 API —— scripts/business-analysis.ts 直接 import,不走子进程
// ---------------------------------------------------------------------------

export type BusinessMap = {
  routes: RouteInfo[];
  operations: ApiOperation[];
  domains: DomainInfo[];
  stores: StoreInfo[];
};

export function buildBusinessMap(): BusinessMap {
  const operations = extractOperations();
  const routes = extractRoutes();
  const domains = extractDomains(routes, buildOperationAliases(operations));
  const stores = extractStores();
  return { routes, operations, domains, stores };
}

export function renderPanoramaOf(map: BusinessMap): string {
  return renderPanorama(map.routes, map.operations, map.domains, map.stores);
}

export function renderDomainOf(map: BusinessMap, name: string): string | null {
  const domain = map.domains.find((d) => d.name === name);
  if (!domain) return null;
  return renderDomain(domain, map.routes, map.operations, map.stores);
}

export function renderJsonOf(map: BusinessMap): string {
  return renderJson(map.routes, map.operations, map.domains, map.stores);
}

// ---------------------------------------------------------------------------
// 7. CLI 入口 —— --format= 约定与 scripts/whitebox-report.ts 一致。
// 被 import 时不执行,否则 business-analysis.ts 一加载就会往 stdout 吐一份骨架。
// ---------------------------------------------------------------------------

const argOf = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

function main(): void {
  const format = (argOf('format') ?? 'markdown') as
    | 'markdown'
    | 'panorama'
    | 'domain'
    | 'json';

  const map = buildBusinessMap();

  switch (format) {
    case 'json':
      console.log(renderJsonOf(map));
      break;
    case 'domain': {
      const name = argOf('domain');
      if (!name) {
        console.error('--format=domain 需要同时传 --domain=<名字>');
        process.exit(2);
      }
      const rendered = renderDomainOf(map, name);
      if (rendered === null) {
        console.error(
          `未知业务域 "${name}"。可选:${map.domains.map((d) => d.name).join(', ')}`,
        );
        process.exit(2);
      }
      console.log(rendered);
      break;
    }
    default:
      // panorama 与 markdown 同一份内容:前者喂模型,后者给人看
      console.log(renderPanoramaOf(map));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

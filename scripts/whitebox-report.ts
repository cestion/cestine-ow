#!/usr/bin/env tsx
/**
 * White-box Test Report Aggregator
 *
 * Reads Vitest's JSON reporter output plus the v8 coverage summary and emits a
 * single aggregated report in one of three shapes:
 *
 *   --format=markdown  (default) human report → job summary / PR comment / 本地终端
 *   --format=json      compact machine summary → CI job outputs (GITHUB_OUTPUT)
 *   --format=ai        prompt-sized block → 注入 AI code review 的上下文
 *
 * The `ai` format is the point of this script: it turns "39 tests passed" into
 * signal the reviewer model can actually act on — which *changed* files are
 * uncovered, which assertions failed and why. Feeding raw JSON to an LLM wastes
 * context and buries the lede.
 *
 * Env:
 *   VITEST_RESULTS    path to vitest --reporter=json output (default /tmp/vitest-results.json)
 *   COVERAGE_SUMMARY  path to coverage-summary.json        (default coverage/coverage-summary.json)
 *   BASE_SHA/HEAD_SHA optional — enables the changed-file coverage section
 *   VITEST_EXIT_CODE  vitest's exit code, distinguishes "crashed" from "all green"
 *
 * Consumed by the `whitebox-test` job in .github/workflows/unified-ci.yml and by
 * the `whitebox-testing` skill in .agents/skills/.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const ROOT = process.cwd();

const VITEST_RESULTS = process.env.VITEST_RESULTS || '/tmp/vitest-results.json';
const COVERAGE_SUMMARY =
  process.env.COVERAGE_SUMMARY || resolve(ROOT, 'coverage/coverage-summary.json');
const BASE_SHA = process.env.BASE_SHA;
const HEAD_SHA = process.env.HEAD_SHA;
const VITEST_EXIT_CODE = process.env.VITEST_EXIT_CODE;

/** Cap the failure list so a fully-red suite can't blow up a Feishu card or an LLM prompt. */
const MAX_FAILURES = 20;
/** Vitest failure messages carry full stack traces; only the head is diagnostic. */
const MAX_FAILURE_MESSAGE_CHARS = 400;
/** Cap the uncovered-file list in the AI block. */
const MAX_UNCOVERED_FILES = 15;

// ---------------------------------------------------------------------------
// Types — only the fields we actually read from Vitest's JSON reporter
// ---------------------------------------------------------------------------

type AssertionResult = {
  fullName: string;
  title: string;
  status: string;
  failureMessages?: string[];
};

type TestFileResult = {
  name: string;
  status: string;
  assertionResults?: AssertionResult[];
};

type VitestReport = {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  success?: boolean;
  /** One entry per test *file*. Note `numTotalTestSuites` counts `describe`
   *  blocks, not files — don't use it for a file count. */
  testResults?: TestFileResult[];
};

type CoverageMetric = { total: number; covered: number; pct: number };
type CoverageEntry = {
  lines: CoverageMetric;
  statements: CoverageMetric;
  functions: CoverageMetric;
  branches: CoverageMetric;
};

type Status = 'passed' | 'failed' | 'empty' | 'error';

type Failure = { file: string; name: string; message: string };

type ChangedFileCoverage = { file: string; pct: number; covered: number; total: number };

type Summary = {
  status: Status;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  files: number;
  failedFiles: number;
  coverage: { lines: number; statements: number; functions: number; branches: number } | null;
  failures: Failure[];
  /** Changed files that fall inside the coverage scope, worst-covered first. */
  changedCoverage: ChangedFileCoverage[];
  /** Changed source files with no coverage entry at all (outside scope or never imported). */
  changedUntracked: string[];
};

// ---------------------------------------------------------------------------
// 1. Load raw inputs
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Changed files, filtered to what the coverage scope could plausibly contain.
 * Mirrors the exclusions used across unified-ci.yml so the numbers line up with
 * the other jobs' notion of "first-party source".
 */
function getChangedSourceFiles(): string[] {
  if (!BASE_SHA || !HEAD_SHA) return [];
  try {
    const out = execSync(`git diff --name-only ${BASE_SHA} ${HEAD_SHA}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => !/^src\/api\/__generated__\//.test(f))
      .filter((f) => !/^src\/solana\//.test(f))
      .filter((f) => f !== 'src/routeTree.gen.ts')
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => !/^src\/test\//.test(f));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Build the summary
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const clean = s.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function buildSummary(): Summary {
  const report = readJson<VitestReport>(VITEST_RESULTS);
  const coverageRaw = readJson<Record<string, CoverageEntry>>(COVERAGE_SUMMARY);

  const coverage = coverageRaw?.total
    ? {
        lines: coverageRaw.total.lines.pct,
        statements: coverageRaw.total.statements.pct,
        functions: coverageRaw.total.functions.pct,
        branches: coverageRaw.total.branches.pct,
      }
    : null;

  // Vitest produced nothing — config error, or an import blew up before any
  // suite ran. Distinct from "tests failed": there is no result to report.
  if (!report) {
    return {
      status: 'error',
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      files: 0,
      failedFiles: 0,
      coverage,
      failures: [],
      changedCoverage: [],
      changedUntracked: [],
    };
  }

  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

  let status: Status;
  if (total === 0) {
    status = 'empty';
  } else if (failed === 0 && (VITEST_EXIT_CODE === undefined || VITEST_EXIT_CODE === '0')) {
    status = 'passed';
  } else {
    status = 'failed';
  }

  const testFiles = report.testResults ?? [];

  const failures: Failure[] = [];
  for (const file of testFiles) {
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      failures.push({
        file: relative(ROOT, file.name) || file.name,
        name: assertion.fullName || assertion.title,
        message: truncate(assertion.failureMessages?.[0] ?? '', MAX_FAILURE_MESSAGE_CHARS),
      });
    }
  }

  // --- changed-file coverage ------------------------------------------------
  const changed = getChangedSourceFiles();
  const changedCoverage: ChangedFileCoverage[] = [];
  const changedUntracked: string[] = [];

  if (changed.length && coverageRaw) {
    // coverage-summary.json keys are absolute paths; index by repo-relative path.
    const byRelPath = new Map<string, CoverageEntry>();
    for (const [abs, entry] of Object.entries(coverageRaw)) {
      if (abs === 'total') continue;
      byRelPath.set(relative(ROOT, abs), entry);
    }

    for (const file of changed) {
      const entry = byRelPath.get(file);
      if (entry) {
        changedCoverage.push({
          file,
          pct: entry.lines.pct,
          covered: entry.lines.covered,
          total: entry.lines.total,
        });
      } else {
        changedUntracked.push(file);
      }
    }
    changedCoverage.sort((a, b) => a.pct - b.pct);
  }

  return {
    status,
    total,
    passed,
    failed,
    skipped,
    files: testFiles.length,
    failedFiles: testFiles.filter((f) => f.status === 'failed').length,
    coverage,
    failures,
    changedCoverage,
    changedUntracked,
  };
}

// ---------------------------------------------------------------------------
// 3. Renderers
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<Status, string> = {
  passed: '✅ **全部通过**',
  failed: '❌ **有用例失败**',
  empty: '⚪️ **暂无测试用例**',
  error: '🟠 **Vitest 执行异常**(未产出结果文件,多半是配置或模块导入阶段就失败了)',
};

function pct(n: number | undefined): string {
  return n === undefined ? '—' : `${n}%`;
}

function renderMarkdown(s: Summary): string {
  const lines: string[] = [];
  lines.push('## 🧪 白盒单测 (Vitest)');
  lines.push('');
  lines.push(STATUS_LABEL[s.status]);
  lines.push('');

  lines.push('| 测试文件 | 总用例 | 通过 | 失败 | 跳过 |');
  lines.push('|---:|---:|---:|---:|---:|');
  lines.push(`| ${s.files} | ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} |`);
  lines.push('');

  if (s.coverage) {
    lines.push('**覆盖率**(仅统计逻辑层,范围见 `vitest.config.ts` 的 `coverage.include`)');
    lines.push('');
    lines.push('| 行 | 语句 | 函数 | 分支 |');
    lines.push('|---:|---:|---:|---:|');
    lines.push(
      `| ${pct(s.coverage.lines)} | ${pct(s.coverage.statements)} | ${pct(s.coverage.functions)} | ${pct(s.coverage.branches)} |`,
    );
    lines.push('');
  }

  if (s.failures.length) {
    lines.push(`### 失败用例(${s.failures.length})`);
    lines.push('');
    for (const f of s.failures.slice(0, MAX_FAILURES)) {
      lines.push(`- \`${f.file}\` › ${f.name}`);
      if (f.message) {
        lines.push('  ```');
        for (const line of f.message.split('\n').slice(0, 6)) lines.push(`  ${line}`);
        lines.push('  ```');
      }
    }
    if (s.failures.length > MAX_FAILURES) {
      lines.push(`- _…另有 ${s.failures.length - MAX_FAILURES} 条失败,详见 Actions 日志_`);
    }
    lines.push('');
  }

  if (s.changedCoverage.length || s.changedUntracked.length) {
    lines.push('### 本次改动文件的覆盖情况');
    lines.push('');
    if (s.changedCoverage.length) {
      lines.push('| 文件 | 行覆盖率 | 已覆盖/总行 |');
      lines.push('|---|---:|---:|');
      for (const c of s.changedCoverage) {
        const flag = c.pct === 0 ? ' ⚠️' : '';
        lines.push(`| \`${c.file}\`${flag} | ${c.pct}% | ${c.covered}/${c.total} |`);
      }
      lines.push('');
    }
    if (s.changedUntracked.length) {
      lines.push(
        `<details><summary>另有 ${s.changedUntracked.length} 个改动文件不在覆盖率统计范围内</summary>`,
      );
      lines.push('');
      for (const f of s.changedUntracked) lines.push(`- \`${f}\``);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Compact block injected into the code-review prompt. Optimized for signal per
 * token: the model gets the verdict, the failures, and — most importantly — which
 * of the files in this very diff are untested.
 */
function renderAi(s: Summary): string {
  const lines: string[] = [];

  if (s.status === 'empty') {
    lines.push('本次运行没有任何测试用例(仓库测试尚未铺开)。评审时请把「该不该补测试」作为一项明确结论。');
    return lines.join('\n');
  }

  if (s.status === 'error') {
    lines.push('Vitest 执行异常,未产出结果文件 — 测试基建本身可能被这次改动破坏了,请优先排查。');
    return lines.join('\n');
  }

  lines.push(
    `结果:${s.status === 'passed' ? '全部通过' : '有失败'} — 共 ${s.total} 个用例,通过 ${s.passed},失败 ${s.failed},跳过 ${s.skipped}(${s.files} 个测试文件)。`,
  );

  if (s.coverage) {
    lines.push(
      `整体覆盖率:行 ${s.coverage.lines}% / 分支 ${s.coverage.branches}% / 函数 ${s.coverage.functions}%。`,
    );
  }

  if (s.failures.length) {
    lines.push('');
    lines.push('失败用例:');
    for (const f of s.failures.slice(0, MAX_FAILURES)) {
      lines.push(`- ${f.file} › ${f.name}`);
      if (f.message) lines.push(`  原因:${truncate(f.message.split('\n')[0], 200)}`);
    }
  }

  const uncovered = s.changedCoverage.filter((c) => c.pct === 0);
  const partially = s.changedCoverage.filter((c) => c.pct > 0 && c.pct < 60);

  if (uncovered.length) {
    lines.push('');
    lines.push('本次改动中「零覆盖」的文件(重点关注,这些改动没有任何测试保护):');
    for (const c of uncovered.slice(0, MAX_UNCOVERED_FILES)) {
      lines.push(`- ${c.file} (0/${c.total} 行)`);
    }
    if (uncovered.length > MAX_UNCOVERED_FILES) {
      lines.push(`- …另有 ${uncovered.length - MAX_UNCOVERED_FILES} 个`);
    }
  }

  if (partially.length) {
    lines.push('');
    lines.push('本次改动中覆盖率偏低(<60%)的文件:');
    for (const c of partially.slice(0, MAX_UNCOVERED_FILES)) {
      lines.push(`- ${c.file} (${c.pct}%)`);
    }
  }

  return lines.join('\n');
}

/** Flat shape — the CI job writes these straight into GITHUB_OUTPUT. */
function renderJson(s: Summary): string {
  return JSON.stringify(
    {
      status: s.status,
      total: s.total,
      passed: s.passed,
      failed: s.failed,
      skipped: s.skipped,
      files: s.files,
      failedFiles: s.failedFiles,
      coverageLines: s.coverage?.lines ?? null,
      coverageBranches: s.coverage?.branches ?? null,
      coverageFunctions: s.coverage?.functions ?? null,
      coverageStatements: s.coverage?.statements ?? null,
      passRate: s.total > 0 ? Number(((s.passed / s.total) * 100).toFixed(1)) : null,
      changedZeroCoverage: s.changedCoverage.filter((c) => c.pct === 0).map((c) => c.file),
      failures: s.failures.slice(0, MAX_FAILURES),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 4. Entry
// ---------------------------------------------------------------------------

const formatArg = process.argv.find((a) => a.startsWith('--format='));
const format = (formatArg?.split('=')[1] ?? 'markdown') as 'markdown' | 'json' | 'ai';

const summary = buildSummary();

switch (format) {
  case 'json':
    console.log(renderJson(summary));
    break;
  case 'ai':
    console.log(renderAi(summary));
    break;
  default:
    console.log(renderMarkdown(summary));
}

#!/usr/bin/env tsx
/**
 * PR Impact Analysis
 *
 * For each changed file in the PR, computes:
 *   1. Which route(s) it belongs to (TanStack Router file-based routing under src/routes/)
 *   2. Reverse-dependency fan-out — who imports it (via madge)
 *   3. Categorization: route / component / hook / store / provider / util / api / other
 *
 * Covers the whole first-party codebase (src/, scripts/, root configs, CI,
 * infra), not just src/ — a change to vite.config.ts or a workflow can matter
 * as much as a component change.
 *
 * Emits Markdown to stdout, consumed by the pr-analysis.yml workflow as a
 * sticky PR comment.
 */

import { execSync } from "node:child_process"
import { dirname, relative, resolve } from "node:path"

const ROOT = process.cwd()
const SRC = resolve(ROOT, "src")
const ROUTES_DIR = resolve(SRC, "routes")

const BASE_SHA = process.env.BASE_SHA
const HEAD_SHA = process.env.HEAD_SHA

if (!BASE_SHA || !HEAD_SHA) {
  console.error("BASE_SHA and HEAD_SHA env vars required")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// 0. Scope — what counts as "first-party source we care about"
// ---------------------------------------------------------------------------

/** Extensions we analyze (TS/JS + config formats that affect the build). */
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const CONFIG_FILE =
  /^(package\.json|pnpm-workspace\.yaml|tsconfig[.\w-]*\.json|vite\.config\.\w+|biome\.json|orval\.config\.\w+|codama\.json|Dockerfile|\.env\.\w+|sonar-project\.properties)$/

/** Generated / vendored / build-output paths excluded from analysis. */
const EXCLUDED = [
  /^node_modules\//,
  /^dist\//,
  /^\.output\//,
  /^coverage\//,
  /^\.git\//,
  /^src\/api\/__generated__\//,
  /^src\/solana\//,
  /^src\/routeTree\.gen\.ts$/,
  /^pnpm-lock\.yaml$/,
  /\.backup$/,
]

/** Directories scanned by madge for the reverse-dependency graph. */
const MADGE_SCAN_DIRS = ["src/", "scripts/"]

function isInteresting(file: string): boolean {
  if (EXCLUDED.some((re) => re.test(file))) return false
  // Root-level config artifacts (Dockerfile, CI, infra, tsconfig, ...)
  if (/^(\.github\/|aws\/)/.test(file)) return true
  if (!file.includes("/") && CONFIG_FILE.test(file)) return true
  // Any TS/JS source anywhere in the repo
  return SOURCE_EXT.test(file)
}

// ---------------------------------------------------------------------------
// 1. Changed files
// ---------------------------------------------------------------------------

function getChangedFiles(): string[] {
  const out = execSync(`git diff --name-only ${BASE_SHA} ${HEAD_SHA}`, {
    encoding: "utf8",
  })
  return out
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f && isInteresting(f))
}

// ---------------------------------------------------------------------------
// 2. Categorize
// ---------------------------------------------------------------------------

type Category =
  | "route"
  | "component"
  | "hook"
  | "store"
  | "provider"
  | "util"
  | "api"
  | "feature"
  | "layout"
  | "lib"
  | "script"
  | "build"
  | "ci"
  | "infra"
  | "config"
  | "other"

function categorize(file: string): Category {
  if (file.startsWith("src/routes/")) return "route"
  if (file.startsWith("src/hooks/")) return "hook"
  if (file.startsWith("src/stores/")) return "store"
  if (file.startsWith("src/providers/")) return "provider"
  if (file.startsWith("src/components/")) return "component"
  if (file.startsWith("src/features/")) return "feature"
  if (file.startsWith("src/layouts/")) return "layout"
  if (file.startsWith("src/api/")) return "api"
  if (file.startsWith("src/utils/")) return "util"
  if (file.startsWith("src/lib/")) return "lib"
  if (file.startsWith("scripts/")) return "script"
  if (file.startsWith(".github/")) return "ci"
  if (file.startsWith("aws/")) return "infra"
  if (file === "Dockerfile" || file.startsWith("vite.config") || file.startsWith("orval.config"))
    return "build"
  if (!file.includes("/") && CONFIG_FILE.test(file)) return "config"
  return "other"
}

const CATEGORY_ICON: Record<Category, string> = {
  route: "🛣️",
  component: "🧩",
  hook: "🪝",
  store: "🗄️",
  provider: "🔌",
  util: "🔧",
  api: "🌐",
  feature: "✨",
  layout: "📐",
  lib: "📚",
  script: "📜",
  build: "🔨",
  ci: "⚙️",
  infra: "☁️",
  config: "📋",
  other: "📄",
}

// ---------------------------------------------------------------------------
// 3. Route inference (which route pulls in a given non-route file?)
// ---------------------------------------------------------------------------

function inferRouteFromRoutesDir(file: string): string {
  // src/routes/dashboard.tsx → /dashboard
  // src/routes/profile/index.tsx → /profile
  // src/routes/actor/$id.tsx → /actor/$id
  const rel = relative(ROUTES_DIR, resolve(ROOT, file))
  if (rel.startsWith("..")) return ""
  const withoutExt = rel.replace(/\.(tsx?|jsx?)$/, "")
  if (withoutExt === "__root") return "/ (root)"
  if (withoutExt === "index") return "/"
  const parts = withoutExt.split("/").filter((p) => p !== "index")
  return "/" + parts.join("/")
}

// ---------------------------------------------------------------------------
// 4. Reverse-dep lookup via madge
// ---------------------------------------------------------------------------

let depTreeCache: Record<string, string[]> | null = null

/**
 * Scan roots for madge. It keys its JSON output by path relative to cwd, so
 * our `reverseDeps` path math below is prefix-agnostic.
 */
const MADGE_SCAN_ARGS = MADGE_SCAN_DIRS.join(" ")

function loadDepTree(): Record<string, string[]> {
  if (depTreeCache) return depTreeCache
  try {
    const raw = execSync(
      `npx --no madge --extensions ts,tsx --ts-config tsconfig.json --json ${MADGE_SCAN_ARGS}`,
      { encoding: "utf8", maxBuffer: 100 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    )
    depTreeCache = JSON.parse(raw)
  } catch {
    depTreeCache = {}
  }
  return depTreeCache!
}

/** Find which files import `target` (transitive one hop). */
function reverseDeps(target: string): string[] {
  const tree = loadDepTree()
  // Non-TS/JS files (Dockerfile, workflows, JSON) aren't in the dependency
  // graph at all — nothing imports them, so fan-out is meaningfully zero.
  if (!SOURCE_EXT.test(target)) return []

  // madge returns keys relative to the scanned root ('src/', 'scripts/'),
  // and resolves aliases (@/…) or relative specifiers to those keys.
  const key = target.replace(/^(src|scripts)\//, "")
  const results: string[] = []
  for (const [importer, imports] of Object.entries(tree)) {
    if (imports.includes(key)) results.push(importer)
  }
  return results
}

/** Walk up the reverse-dep graph until we hit files under src/routes/. */
function findAffectedRoutes(file: string, seen = new Set<string>()): Set<string> {
  const routes = new Set<string>()
  if (seen.has(file)) return routes
  seen.add(file)

  if (file.startsWith("src/routes/")) {
    routes.add(inferRouteFromRoutesDir(file))
    return routes
  }

  const importers = reverseDeps(file)
  for (const importer of importers) {
    for (const r of findAffectedRoutes(importer, seen)) routes.add(r)
  }
  return routes
}

// ---------------------------------------------------------------------------
// 5. Report
// ---------------------------------------------------------------------------

function render(): string {
  const files = getChangedFiles()

  if (files.length === 0) {
    return `## 🎯 PR Impact Analysis\n\n_No TypeScript source files changed._\n`
  }

  const byCategory = new Map<Category, string[]>()
  for (const f of files) {
    const c = categorize(f)
    if (!byCategory.has(c)) byCategory.set(c, [])
    byCategory.get(c)!.push(f)
  }

  const allAffectedRoutes = new Set<string>()
  const fileImpact: { file: string; category: Category; routes: string[]; importers: number }[] = []

  for (const f of files) {
    const routes = [...findAffectedRoutes(f)].filter(Boolean)
    routes.forEach((r) => allAffectedRoutes.add(r))
    fileImpact.push({
      file: f,
      category: categorize(f),
      routes,
      importers: reverseDeps(f).length,
    })
  }

  const lines: string[] = []
  lines.push("## 🎯 PR Impact Analysis")
  lines.push("")
  lines.push(`**${files.length}** source files changed across **${byCategory.size}** categories.`)
  lines.push("")

  // Category summary table
  lines.push("### By category")
  lines.push("")
  lines.push("| | Category | Count |")
  lines.push("|---|---|---|")
  for (const [cat, list] of [...byCategory.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`| ${CATEGORY_ICON[cat]} | ${cat} | ${list.length} |`)
  }
  lines.push("")

  // Affected routes
  lines.push("### 🛣️ Affected routes")
  lines.push("")
  if (allAffectedRoutes.size === 0) {
    lines.push("_None detected — changes may be in non-UI code (utils, api, etc)._")
  } else {
    const sorted = [...allAffectedRoutes].sort()
    for (const r of sorted) lines.push(`- \`${r}\``)
  }
  lines.push("")

  // Per-file breakdown
  lines.push("### Per-file impact")
  lines.push("")
  lines.push("<details><summary>Show details</summary>")
  lines.push("")
  lines.push("| File | Category | Importers | Affected routes |")
  lines.push("|---|---|---:|---|")
  for (const f of fileImpact.sort((a, b) => b.importers - a.importers)) {
    const routes = f.routes.length ? f.routes.map((r) => `\`${r}\``).join(", ") : "—"
    lines.push(
      `| \`${f.file}\` | ${CATEGORY_ICON[f.category]} ${f.category} | ${f.importers} | ${routes} |`,
    )
  }
  lines.push("")
  lines.push("</details>")
  lines.push("")

  // High-fanout warning
  const hotspots = fileImpact.filter((f) => f.importers >= 5)
  if (hotspots.length) {
    lines.push("### ⚠️ Regression hotspots")
    lines.push("")
    lines.push("These files are imported by many places — extra care needed:")
    lines.push("")
    for (const h of hotspots) {
      lines.push(`- \`${h.file}\` — **${h.importers}** importers`)
    }
    lines.push("")
  }

  return lines.join("\n")
}

console.log(render())

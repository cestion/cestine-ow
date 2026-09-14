/**
 * 共享 LLM 调用 —— Anthropic 兼容的 /v1/messages。
 *
 * 选路与 `.github/workflows/unified-ci.yml` 里 `push-code-review` 那段 bash 一致:
 * 配了 MiniMax 就走 MiniMax(key 经 scripts/lib/keyring.sh 解混淆),否则回落
 * ANTHROPIC_API_KEY + claude-opus-4-8。
 *
 * 为什么不把那段 bash 也换成这个:它已经在跑、已经验证过,改它只会平白引入风险。
 * 两边的分工是清楚的 —— 单次调用留在 YAML 里,多段编排(本文件的使用者)走 TS。
 * 改选路逻辑时记得两边一起改。
 *
 * Env:
 *   MINIMAX_KEY_BLOB   混淆后的 MiniMax key
 *   MINIMAX_BASE_URL   默认 https://api.minimaxi.com/anthropic
 *   REVIEW_MODEL       模型 ID,默认 MiniMax-M3
 *   ANTHROPIC_API_KEY  回落用
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEYRING = resolve(process.cwd(), 'scripts/lib/keyring.sh');

export type LlmConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  provider: 'minimax' | 'anthropic';
};

export class LlmUnavailableError extends Error {}

/**
 * blob 形如 `<unix 秒>.<32 位 hex IV>.<base64 密文>`,三段缺一不可。
 *
 * 先验形状再调 openssl:解码失败时 openssl 只会吐一句 "bad decrypt",
 * 分不清是「填错了东西」还是「盐值不对」。这里把能静态判断的先判掉,
 * 让 CI 日志直接说出原因。返回空串表示形状没问题。
 */
function describeBlobShape(blob: string): string {
  const parts = blob.split('.');
  if (parts.length !== 3) {
    return (
      `格式不对 —— 期望 3 段 \`<时间戳>.<IV>.<密文>\`,实际 ${parts.length} 段。` +
      '最常见的原因是把 MiniMax 的原始 key 直接填进了 MINIMAX_KEY_BLOB;' +
      '它必须是 `scripts/lib/keyring.sh encode <key>` 的产物。'
    );
  }
  const [ts, iv, cipher] = parts;
  if (!/^\d+$/.test(ts)) return `第 1 段应为纯数字时间戳,实际不是(长度 ${ts.length})`;
  if (!/^[0-9a-f]{32}$/i.test(iv)) return `第 2 段应为 32 位 hex IV,实际长度 ${iv.length}`;
  if (!cipher) return '第 3 段密文为空';
  return '';
}

function decodeMinimaxKey(blob: string): { key: string; reason: string } {
  const shape = describeBlobShape(blob);
  if (shape) return { key: '', reason: shape };

  try {
    // stderr 要接住 —— 丢掉它就等于把「为什么失败」一起丢掉了
    const key = execFileSync('bash', [KEYRING, 'decode', blob], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (key) return { key, reason: '' };
    return {
      key: '',
      reason:
        'keyring.sh 解出空串 —— 多半是加密时的 KR_S 盐值与解密时不一致(默认 `cestine`),或 blob 被截断',
    };
  } catch (err) {
    // 注意别用 err.message —— execFileSync 会把整条命令(含 blob)拼进去,
    // 那等于把混淆后的密钥打进 CI 日志。只取 stderr,没有就给结构化说明。
    const e = err as { stderr?: Buffer | string; status?: number };
    const stderr = (e.stderr?.toString() ?? '').trim();
    return {
      key: '',
      reason: stderr
        ? `keyring.sh 报错:${stderr}`
        : `keyring.sh 非零退出(code ${e.status ?? '?'})—— openssl 解密失败,` +
          '通常是加密时的 KR_S 盐值与解密时不一致(默认 `cestine`),或 blob 内容被改过',
    };
  }
}

export function resolveLlm(): LlmConfig {
  const model = process.env.REVIEW_MODEL || 'MiniMax-M3';
  // trim:GitHub secret 粘贴时很容易带上首尾空白,带着去算 sha256 必然解不出来
  const blob = process.env.MINIMAX_KEY_BLOB?.trim();

  let minimaxFailure = '';
  if (model.startsWith('MiniMax') && blob) {
    const { key, reason } = decodeMinimaxKey(blob);
    if (key) {
      const base = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic';
      return { model, apiBase: `${base}/v1/messages`, apiKey: key, provider: 'minimax' };
    }
    // 不在这里抛 —— 下面还有 ANTHROPIC_API_KEY 兜底,MiniMax 配坏了不该让整轮跑不起来
    minimaxFailure = reason;
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    if (minimaxFailure) {
      process.stderr.write(`⚠️ MiniMax 密钥解码失败,回落 Anthropic:${minimaxFailure}\n`);
    }
    return {
      model: 'claude-opus-4-8',
      apiBase: 'https://api.anthropic.com/v1/messages',
      apiKey: anthropicKey,
      provider: 'anthropic',
    };
  }

  if (minimaxFailure) {
    throw new LlmUnavailableError(
      `MiniMax 密钥解码失败,且没有 ANTHROPIC_API_KEY 可回落。\n  原因:${minimaxFailure}`,
    );
  }
  throw new LlmUnavailableError('未配置 LLM key(需要 MINIMAX_KEY_BLOB 或 ANTHROPIC_API_KEY)');
}

/** 报错文本里可能回显 key,外抛前一律打码。 */
function redact(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('***') : text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CallOptions = {
  system: string;
  user: string;
  maxTokens?: number;
  /** 429 / 5xx 的重试次数。全量分析要连打 26 次,单次抖动不该拖垮整轮。 */
  retries?: number;
  /** 单次请求超时(毫秒) */
  timeoutMs?: number;
};

export async function callLlm(cfg: LlmConfig, opts: CallOptions): Promise<string> {
  const { system, user, maxTokens = 4000, retries = 3, timeoutMs = 300_000 } = opts;

  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(2 ** attempt * 1000);

    let response: Response;
    try {
      response = await fetch(cfg.apiBase, {
        method: 'POST',
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cfg.model,
          system,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = `请求失败:${(err as Error).message}`;
      continue;
    }

    if (!response.ok) {
      const body = redact(await response.text().catch(() => ''), cfg.apiKey);
      lastError = `HTTP ${response.status}:${body.slice(0, 500)}`;
      // 4xx(除 429)是请求本身有问题,重试没有意义
      if (response.status !== 429 && response.status < 500) break;
      continue;
    }

    const json = (await response.json()) as {
      content?: { type: string; text?: string }[];
    };
    const text = (json.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n')
      .trim();

    if (text) return text;
    lastError = '响应里没有 text 内容';
  }

  throw new Error(redact(lastError, cfg.apiKey));
}

// ---------------------------------------------------------------------------
// 自检:`tsx scripts/lib/llm.ts` —— 只报「能不能用」,永远不打印 key 内容
// ---------------------------------------------------------------------------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const blob = process.env.MINIMAX_KEY_BLOB?.trim();
  console.log(`REVIEW_MODEL      = ${process.env.REVIEW_MODEL || '(未设置,默认 MiniMax-M3)'}`);
  console.log(
    `MINIMAX_KEY_BLOB  = ${blob ? `${blob.length} 字符 / ${blob.split('.').length} 段` : '(未设置)'}`,
  );
  console.log(`ANTHROPIC_API_KEY = ${process.env.ANTHROPIC_API_KEY ? '已设置' : '(未设置)'}`);
  console.log(`KR_S              = ${process.env.KR_S ? '已设置(非默认盐值)' : '(未设置,用默认 cestine)'}`);
  try {
    const cfg = resolveLlm();
    console.log(`\n✓ 可用:${cfg.provider} / ${cfg.model}`);
    console.log(`  endpoint:${cfg.apiBase}`);
    console.log(`  key 长度:${cfg.apiKey.length}(不打印内容)`);
  } catch (err) {
    console.error(`\n✗ ${(err as Error).message}`);
    process.exit(1);
  }
}

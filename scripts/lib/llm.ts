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

const KEYRING = resolve(process.cwd(), 'scripts/lib/keyring.sh');

export type LlmConfig = {
  model: string;
  apiBase: string;
  apiKey: string;
  provider: 'minimax' | 'anthropic';
};

export class LlmUnavailableError extends Error {}

function decodeMinimaxKey(blob: string): string {
  try {
    return execFileSync('bash', [KEYRING, 'decode', blob], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

export function resolveLlm(): LlmConfig {
  const model = process.env.REVIEW_MODEL || 'MiniMax-M3';
  const blob = process.env.MINIMAX_KEY_BLOB;

  if (model.startsWith('MiniMax') && blob) {
    const apiKey = decodeMinimaxKey(blob);
    if (!apiKey) {
      throw new LlmUnavailableError('MiniMax 密钥解码失败(MINIMAX_KEY_BLOB 无效?)');
    }
    const base = process.env.MINIMAX_BASE_URL || 'https://api.minimaxi.com/anthropic';
    return { model, apiBase: `${base}/v1/messages`, apiKey, provider: 'minimax' };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      model: 'claude-opus-4-8',
      apiBase: 'https://api.anthropic.com/v1/messages',
      apiKey: anthropicKey,
      provider: 'anthropic',
    };
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

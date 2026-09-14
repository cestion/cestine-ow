import { vi } from 'vitest';

/**
 * Solana mock harness。
 *
 * 刻意**只挡网络边界**，不整包替换：
 * `PublicKey` / `TransactionMessage` / `VersionedTransaction` / `AccountRole` /
 * `address()` 都是纯计算，在 node 里跑得好好的，替掉反而让用例测不到真实的
 * 序列化与地址推导逻辑（那正是白盒要覆盖的部分）。
 *
 * 真正要挡的是两处会发请求的：
 * - `@solana/web3.js` 的 `Connection`
 * - `@solana/kit` 的 `createSolanaRpcSubscriptions`（会开 websocket）
 *
 * 用法（写在测试文件顶层）：
 *
 * ```ts
 * vi.mock('@solana/web3.js', async () => {
 *   const { createSolanaWeb3Mock } = await import('@/test/mocks/solana');
 *   return createSolanaWeb3Mock();
 * });
 * ```
 *
 * 摆返回值：
 *
 * ```ts
 * import { solanaRpcState, solanaRpcMocks, resetSolanaMocks } from '@/test/mocks/solana';
 *
 * beforeEach(resetSolanaMocks);
 * solanaRpcState.balance = 0;                       // 触发余额不足分支
 * solanaRpcState.simulateError = { InsufficientFundsForRent: {} };
 * ```
 */

export const solanaRpcState = {
  blockhash: 'MockBlockhash11111111111111111111111111111111',
  lastValidBlockHeight: 1_000_000,
  slot: 250_000_000,
  /** lamports */
  balance: 5_000_000_000,
  signature: 'MockTxSignature1111111111111111111111111111111111111111111111111',
  /** 非 null 时 simulateTransaction 返回失败 */
  simulateError: null as unknown,
  simulateLogs: [] as string[],
  simulateUnitsConsumed: 10_000,
  /** 非 null 时 confirmTransaction 返回失败 */
  confirmError: null as unknown,
  accountInfo: null as unknown,
};

export const solanaRpcMocks = {
  getLatestBlockhash: vi.fn(async () => ({
    blockhash: solanaRpcState.blockhash,
    lastValidBlockHeight: solanaRpcState.lastValidBlockHeight,
  })),
  getBalance: vi.fn(async () => solanaRpcState.balance),
  getSlot: vi.fn(async () => solanaRpcState.slot),
  getAccountInfo: vi.fn(async () => solanaRpcState.accountInfo),
  getParsedAccountInfo: vi.fn(async () => ({
    value: solanaRpcState.accountInfo,
  })),
  simulateTransaction: vi.fn(async () => ({
    value: {
      err: solanaRpcState.simulateError,
      logs: solanaRpcState.simulateLogs,
      unitsConsumed: solanaRpcState.simulateUnitsConsumed,
    },
  })),
  sendRawTransaction: vi.fn(async () => solanaRpcState.signature),
  sendTransaction: vi.fn(async () => solanaRpcState.signature),
  confirmTransaction: vi.fn(async () => ({
    value: { err: solanaRpcState.confirmError },
  })),
  getSignatureStatuses: vi.fn(async () => ({
    value: [
      {
        slot: solanaRpcState.slot,
        confirmations: 1,
        err: solanaRpcState.confirmError,
        confirmationStatus: 'confirmed',
      },
    ],
  })),
  getTokenAccountBalance: vi.fn(async () => ({
    value: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
  })),
  getMinimumBalanceForRentExemption: vi.fn(async () => 2_039_280),
  onAccountChange: vi.fn(() => 1),
  removeAccountChangeListener: vi.fn(async () => {}),
};

export function resetSolanaMocks() {
  solanaRpcState.blockhash = 'MockBlockhash11111111111111111111111111111111';
  solanaRpcState.lastValidBlockHeight = 1_000_000;
  solanaRpcState.slot = 250_000_000;
  solanaRpcState.balance = 5_000_000_000;
  solanaRpcState.simulateError = null;
  solanaRpcState.simulateLogs = [];
  solanaRpcState.simulateUnitsConsumed = 10_000;
  solanaRpcState.confirmError = null;
  solanaRpcState.accountInfo = null;

  for (const fn of Object.values(solanaRpcMocks)) fn.mockClear();
}

/** 只挡网络的 Connection 替身；构造参数被吞掉，不会真的连 RPC */
export class MockConnection {
  readonly rpcEndpoint: string;

  constructor(endpoint = 'http://localhost:8899') {
    this.rpcEndpoint = endpoint;
    Object.assign(this, solanaRpcMocks);
  }
}

/**
 * `vi.mock('@solana/web3.js', ...)` 的返回值：
 * 保留全部真实导出，只把 `Connection` 换成替身。
 */
export async function createSolanaWeb3Mock() {
  const actual =
    await vi.importActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  return { ...actual, Connection: MockConnection };
}

/**
 * `vi.mock('@solana/kit', ...)` 的返回值：
 * 保留 `address` / `AccountRole` 等纯函数，只挡会开 websocket 的订阅入口。
 */
export async function createSolanaKitMock() {
  const actual =
    await vi.importActual<typeof import('@solana/kit')>('@solana/kit');
  return {
    ...actual,
    createSolanaRpcSubscriptions: vi.fn(() => ({
      accountNotifications: vi.fn(async () => ({
        [Symbol.asyncIterator]: async function* () {},
      })),
      signatureNotifications: vi.fn(async () => ({
        [Symbol.asyncIterator]: async function* () {},
      })),
      slotNotifications: vi.fn(async () => ({
        [Symbol.asyncIterator]: async function* () {},
      })),
    })),
  };
}

import { createElement, Fragment, type ReactNode } from 'react';
import { vi } from 'vitest';

/**
 * Privy 共享 mock harness —— T3(49 个依赖 Privy 的 hook)能被测的前提。
 *
 * `@privy-io/react-auth` 在 jsdom 下无法真跑（要 iframe、要远端 auth），
 * 所以这里按全仓实际用到的导出面做一套可控替身：
 *
 * | 模块 | 用到的导出 |
 * |---|---|
 * | `@privy-io/react-auth` | `usePrivy` `useLogin` `useWallets` `useCreateWallet` `useSessionSigners` `PrivyProvider` |
 * | `@privy-io/react-auth/solana` | `useWallets` `useSignTransaction` `useSignMessage` `useSignAndSendTransaction` `useCreateWallet` `useSessionSigners` |
 * | `@privy-io/react-auth/extended-chains` | `useCreateWallet` |
 *
 * 用法（三条 `vi.mock` 必须写在测试文件顶层才会被提升）：
 *
 * ```ts
 * vi.mock('@privy-io/react-auth', async () => {
 *   const { createPrivyReactAuthMock } = await import('@/test/mocks/privy');
 *   return createPrivyReactAuthMock();
 * });
 * vi.mock('@privy-io/react-auth/solana', async () => {
 *   const { createPrivySolanaMock } = await import('@/test/mocks/privy');
 *   return createPrivySolanaMock();
 * });
 * ```
 *
 * 摆状态、触发回调：
 *
 * ```ts
 * import { privyState, privyLoginCallbacks, resetPrivyMocks } from '@/test/mocks/privy';
 *
 * beforeEach(resetPrivyMocks);
 *
 * privyState.ready = true;
 * privyState.authenticated = true;
 * privyState.user = makePrivyUser({ id: 'did:privy:abc' });
 *
 * // 模拟 Privy 登录成功回调
 * privyLoginCallbacks.onComplete?.({ user: privyState.user });
 * ```
 */

export type MockPrivyLinkedAccount = {
  type?: string;
  address?: string;
  chainType?: string;
  connectorType?: string;
  walletClientType?: string;
  [key: string]: unknown;
};

export type MockPrivyUser = {
  id: string;
  linkedAccounts: MockPrivyLinkedAccount[];
  wallet?: MockPrivyLinkedAccount;
  [key: string]: unknown;
};

export type MockPrivyWallet = {
  address: string;
  chainType?: string;
  walletClientType?: string;
  connectorType?: string;
  [key: string]: unknown;
};

type LoginCallbacks = {
  onComplete?: (args: { user: MockPrivyUser }) => void;
  onError?: (code: unknown) => void;
};

/** 可变状态：用例直接改字段即可切换分支 */
export const privyState = {
  ready: false,
  authenticated: false,
  user: undefined as MockPrivyUser | undefined,
  accessToken: 'mock-access-token' as string | null,
  /** `@privy-io/react-auth` 的 useWallets（EVM） */
  wallets: [] as MockPrivyWallet[],
  walletsReady: true,
  /** `@privy-io/react-auth/solana` 的 useWallets */
  solanaWallets: [] as MockPrivyWallet[],
  solanaWalletsReady: true,
};

/** `useLogin({ onComplete, onError })` 传进来的回调，用例可手动触发 */
export const privyLoginCallbacks: LoginCallbacks = {};

export const privyMocks = {
  login: vi.fn(),
  logout: vi.fn(async () => {}),
  getAccessToken: vi.fn(async () => privyState.accessToken),
  createWallet: vi.fn(async () => ({ address: '0xmockwallet' })),
  createExtendedWallet: vi.fn(async () => ({ address: '0xmockwallet' })),
  createSolanaWallet: vi.fn(async () => ({ address: 'SoLmockwallet' })),
  linkWallet: vi.fn(),
  unlinkWallet: vi.fn(async () => privyState.user),
  connectWallet: vi.fn(),
  exportWallet: vi.fn(async () => {}),
  signMessage: vi.fn(async () => ({ signature: 'mock-signature' })),
  signTransaction: vi.fn(async (args: unknown) => args),
  signAndSendTransaction: vi.fn(async () => ({ signature: 'mock-tx-sig' })),
  sendTransaction: vi.fn(async () => ({ hash: '0xmocktx' })),
  addSessionSigners: vi.fn(async () => {}),
  removeSessionSigners: vi.fn(async () => {}),
};

/** 造一个最小可用的 Privy user；不传 linkedAccounts 时默认挂一个 Solana 嵌入式钱包 */
export function makePrivyUser(
  overrides: Partial<MockPrivyUser> = {},
): MockPrivyUser {
  return {
    id: 'did:privy:test',
    linkedAccounts: [
      {
        type: 'wallet',
        address: 'SoLtestwalletaddress1111111111111111111111',
        chainType: 'solana',
        connectorType: 'embedded',
        walletClientType: 'privy',
        // useAppPrivyAccount 的嵌入式钱包匹配条件要求 walletIndex === 0，缺了就匹配不上
        walletIndex: 0,
      },
    ],
    ...overrides,
  };
}

/** 每个用例前调用，把状态和 spy 调用记录清干净 */
export function resetPrivyMocks() {
  privyState.ready = false;
  privyState.authenticated = false;
  privyState.user = undefined;
  privyState.accessToken = 'mock-access-token';
  privyState.wallets = [];
  privyState.walletsReady = true;
  privyState.solanaWallets = [];
  privyState.solanaWalletsReady = true;

  privyLoginCallbacks.onComplete = undefined;
  privyLoginCallbacks.onError = undefined;

  for (const fn of Object.values(privyMocks)) fn.mockClear();
}

function usePrivy() {
  return {
    ready: privyState.ready,
    authenticated: privyState.authenticated,
    user: privyState.user,
    login: privyMocks.login,
    logout: privyMocks.logout,
    getAccessToken: privyMocks.getAccessToken,
    createWallet: privyMocks.createWallet,
    linkWallet: privyMocks.linkWallet,
    unlinkWallet: privyMocks.unlinkWallet,
    connectWallet: privyMocks.connectWallet,
    exportWallet: privyMocks.exportWallet,
    signMessage: privyMocks.signMessage,
    sendTransaction: privyMocks.sendTransaction,
  };
}

function useLogin(callbacks: LoginCallbacks = {}) {
  // 保存回调引用，用例可以手动触发 onComplete / onError 覆盖登录成功/失败分支
  privyLoginCallbacks.onComplete = callbacks.onComplete;
  privyLoginCallbacks.onError = callbacks.onError;
  return { login: privyMocks.login };
}

function useSessionSigners() {
  return {
    addSessionSigners: privyMocks.addSessionSigners,
    removeSessionSigners: privyMocks.removeSessionSigners,
  };
}

function PrivyProvider({ children }: { children?: ReactNode }) {
  return createElement(Fragment, null, children);
}

/** `vi.mock('@privy-io/react-auth', ...)` 的返回值 */
export function createPrivyReactAuthMock() {
  return {
    usePrivy,
    useLogin,
    useLogout: () => ({ logout: privyMocks.logout }),
    useWallets: () => ({
      ready: privyState.walletsReady,
      wallets: privyState.wallets,
    }),
    useCreateWallet: () => ({ createWallet: privyMocks.createWallet }),
    useSessionSigners,
    useSignMessage: () => ({ signMessage: privyMocks.signMessage }),
    PrivyProvider,
  };
}

/** `vi.mock('@privy-io/react-auth/solana', ...)` 的返回值 */
export function createPrivySolanaMock() {
  return {
    usePrivy,
    useWallets: () => ({
      ready: privyState.solanaWalletsReady,
      wallets: privyState.solanaWallets,
    }),
    useCreateWallet: () => ({ createWallet: privyMocks.createSolanaWallet }),
    useSessionSigners,
    useSignTransaction: () => ({
      signTransaction: privyMocks.signTransaction,
    }),
    useSignMessage: () => ({ signMessage: privyMocks.signMessage }),
    useSignAndSendTransaction: () => ({
      signAndSendTransaction: privyMocks.signAndSendTransaction,
    }),
  };
}

/** `vi.mock('@privy-io/react-auth/extended-chains', ...)` 的返回值 */
export function createPrivyExtendedChainsMock() {
  return {
    useCreateWallet: () => ({ createWallet: privyMocks.createExtendedWallet }),
  };
}

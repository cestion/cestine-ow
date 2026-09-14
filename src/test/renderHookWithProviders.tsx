import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  type RenderHookOptions,
  type RenderOptions,
  render,
  renderHook,
} from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';

/**
 * 带 provider 的 `renderHook` / `render` 封装。
 *
 * 项目里的 hook 大量用 `useQuery` / `useMutation`，脱离 QueryClientProvider 直接
 * 抛错。每次调用建一个全新的 QueryClient，保证用例之间不共享缓存。
 *
 * ```ts
 * const { result } = renderHookWithProviders(() => useSomething(id));
 * await waitFor(() => expect(result.current.isSuccess).toBe(true));
 * ```
 */

/** 测试用 QueryClient：关重试、关缓存、关日志，失败立刻暴露而不是默默重试 3 次 */
export function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

type ProvidersOptions = {
  queryClient?: QueryClient;
  /** 额外包一层（i18n、主题、自定义 context 等） */
  wrapper?: (props: { children: ReactNode }) => ReactElement;
};

function buildWrapper({ queryClient, wrapper: Extra }: ProvidersOptions) {
  const client = queryClient ?? createTestQueryClient();

  return function Providers({ children }: { children: ReactNode }) {
    const inner = Extra ? <Extra>{children}</Extra> : <>{children}</>;
    return <QueryClientProvider client={client}>{inner}</QueryClientProvider>;
  };
}

export function renderHookWithProviders<Result, Props>(
  hook: (initialProps: Props) => Result,
  options: ProvidersOptions & Omit<RenderHookOptions<Props>, 'wrapper'> = {},
) {
  const { queryClient, wrapper, ...rest } = options;
  const client = queryClient ?? createTestQueryClient();
  return {
    queryClient: client,
    ...renderHook(hook, {
      wrapper: buildWrapper({ queryClient: client, wrapper }),
      ...rest,
    }),
  };
}

export function renderWithProviders(
  ui: ReactElement,
  options: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {},
) {
  const { queryClient, wrapper, ...rest } = options;
  const client = queryClient ?? createTestQueryClient();
  return {
    queryClient: client,
    ...render(ui, {
      wrapper: buildWrapper({ queryClient: client, wrapper }),
      ...rest,
    }),
  };
}

export * from '@testing-library/react';

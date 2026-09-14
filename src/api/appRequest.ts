import { instrumentApi } from '@amazing-socrates/telemetry-kit';
import axios, { type AxiosRequestConfig, type AxiosResponse } from 'axios';
import { toast } from 'sonner';
import store2 from 'store2';
import { resolveBusinessErrorMessage } from '@/api/resolveBusinessErrorMessage';
import i18n from '@/i18n';
import useGlobalStore from '@/stores/global';
import { parseJsonPreservingSnowflakeIds } from '@/utils/parseSnowflakeJson';

export interface BaseResponse<T> {
  code: number;
  data: T;
  message?: string;
  msg?: string;
}

const axiosClient = axios.create({
  headers: {
    'Content-Type': 'application/json',
  },
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080',
  timeout: 60_000,
  transformResponse: [
    (data: unknown) => {
      if (typeof data !== 'string' || data.length === 0) {
        return data;
      }

      try {
        return parseJsonPreservingSnowflakeIds(data);
      } catch {
        return data;
      }
    },
  ],
});

const UNAUTHORIZED_CODE = 100401;
/** Header token 无效或过期 */
const TOKEN_INVALID_CODE = 100001;
export const AUTH_ERROR_CODES = new Set([
  UNAUTHORIZED_CODE,
  TOKEN_INVALID_CODE,
]);
export const BUSINESS_SUCCESS_CODE = 100000;
let lastUnauthorizedHandledAt = 0;

export class AppBusinessError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'AppBusinessError';
    this.code = code;
  }
}

export type AppAxiosInstanceOptions = {
  /** 命中时不 toast，抛出 {@link AppBusinessError} */
  silentBusinessCodes?: number[];
};

// 请求拦截器：添加 Authorization token
axiosClient.interceptors.request.use(
  (config) => {
    const token = store2.get('userToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    config.headers['Accept-Language'] =
      i18n.language === 'zh-CN' ? 'zh' : i18n.language;
    return config;
  },
  (error) => {
    return Promise.reject(error);
  },
);

// API 层采集：失败复用 reportError；慢接口走性能通道。业务 toast/鉴权跳转逻辑不动。
// 慢阈值不传，走 kit 环境默认（development 10s / test 8s / production 5s）。
instrumentApi(axiosClient);

/**
 * Custom mutator for orval-generated API hooks.
 * Bridges RequestInit style options to axios.
 */
export async function appAxiosInstance<T>(
  url: string,
  options?: RequestInit,
  instanceOptions?: AppAxiosInstanceOptions,
): Promise<T> {
  const { body, method, headers, signal, credentials } = options ?? {};

  const config: AxiosRequestConfig = {
    url,
    method: (method as string) ?? 'GET',
    data: body,
    signal: signal ?? undefined,
    withCredentials: credentials === 'include',
  };

  if (headers) {
    if (headers instanceof Headers) {
      const obj: Record<string, string> = {};
      headers.forEach((value, key) => {
        obj[key] = value;
      });
      config.headers = obj;
    } else if (!Array.isArray(headers)) {
      config.headers = headers as Record<string, string>;
    }
  }

  const response = await axiosClient(config);

  const responseData = response.data as BaseResponse<unknown> | undefined;
  const code = Number(responseData?.code);
  const msg = responseData?.msg ?? responseData?.message;

  if (code !== BUSINESS_SUCCESS_CODE && code !== 200) {
    const rawMessage =
      typeof msg === 'string' && msg ? msg : `Business code ${code}`;
    const errorMessage = resolveBusinessErrorMessage(code, rawMessage);

    if (instanceOptions?.silentBusinessCodes?.includes(code)) {
      throw new AppBusinessError(code, errorMessage);
    }

    if (AUTH_ERROR_CODES.has(code)) {
      // 未授权 / token 失效：toast 后端 msg，清理登录态，并跳回首页。
      const now = Date.now();

      if (
        now - lastUnauthorizedHandledAt > 2000 &&
        typeof window !== 'undefined'
      ) {
        toast.error(errorMessage || 'Unauthorized');
        lastUnauthorizedHandledAt = now;
      }

      // 统一用 store 的清理入口，确保 isLogin/balance 等也同步重置。
      if (useGlobalStore.getState().isLogin || store2.get('userToken')) {
        useGlobalStore.getState().clearUserInfo();
      }

      if (typeof window !== 'undefined' && window.location.pathname !== '/') {
        window.location.assign('/');
      }
    } else if (typeof window !== 'undefined') {
      toast.error(errorMessage || 'Request failed');
    }

    throw new Error(errorMessage);
  }

  return {
    data: response.data,
    status: response.status,
    headers: response.headers,
  } as T;
}

export async function appRequest<T>(options: AxiosRequestConfig): Promise<T> {
  return axiosClient(options).then((res: AxiosResponse<T>) => res.data);
}

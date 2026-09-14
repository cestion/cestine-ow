import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_USER_PRECISION } from '@/constants';
import {
  isEmptyAmount,
  toAmountCeil,
  toAmountFloor,
  toAmountString,
  toDecimalPlaces,
  toSimpleAmount,
} from '@/utils/formatCurrencyAmount';

/**
 * 白盒测试参考样例 —— 写新用例时以本文件为风格模板，约定见
 * `.agents/skills/whitebox-testing/SKILL.md`。
 *
 * 白盒 = 照着实现的分支结构写用例，而不是照着函数名猜行为。本文件每个 describe
 * 都对应源码里一条可执行路径：try 成功分支 / catch 兜底分支 / 默认参数 /
 * roundingMode 两个方向 / 边界值。
 *
 * 一个具体的踩坑点：decimal.js **原生支持 NaN 与 Infinity**，
 * `new Decimal(NaN)` 不抛异常。所以 `toDecimalPlaces(NaN)` 走的是 try 成功分支
 * 返回 `'NaN'`，不是 catch 里的 `'-'`。真正会抛的只有：`''`、非数字字符串、
 * `null`、`undefined`，以及越界的 precision。这种"看名字想当然会错"的地方
 * 正是白盒测试的价值所在。
 */

describe('toDecimalPlaces', () => {
  describe('try 分支：new Decimal(value).toFixed(precision, roundingMode) 成功', () => {
    it('默认 precision 取 DEFAULT_USER_PRECISION，默认 roundingMode 是 ROUND_DOWN（截断而非四舍五入）', () => {
      expect(DEFAULT_USER_PRECISION).toBe(2);
      // 1.239 若四舍五入是 1.24，ROUND_DOWN 截断得 1.23
      expect(toDecimalPlaces('1.239')).toBe('1.23');
    });

    it('roundingMode = ROUND_UP 时向上进位', () => {
      expect(toDecimalPlaces('1.231', 2, Decimal.ROUND_UP)).toBe('1.24');
    });

    it('负数按绝对值方向截断（ROUND_DOWN 朝零取整）', () => {
      expect(toDecimalPlaces('-1.239')).toBe('-1.23');
    });

    it('precision = 0 时返回整数串', () => {
      expect(toDecimalPlaces('1.99', 0)).toBe('1');
    });

    it('高精度输入被截断到 precision 位', () => {
      expect(toDecimalPlaces('0.000001')).toBe('0.00');
    });

    it('0 是合法输入，走 try 分支返回 "0.00"，不是 catch 里的 "-"', () => {
      expect(toDecimalPlaces(0)).toBe('0.00');
    });

    it('NaN / Infinity 被 decimal.js 原生支持，同样走 try 分支', () => {
      expect(toDecimalPlaces(Number.NaN)).toBe('NaN');
      expect(toDecimalPlaces(Number.POSITIVE_INFINITY)).toBe('Infinity');
      expect(toDecimalPlaces(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
    });
  });

  describe('catch 分支：String(value || "-")', () => {
    it('空字符串 → Decimal 构造抛错 → falsy → "-"', () => {
      expect(toDecimalPlaces('')).toBe('-');
    });

    it('非数字字符串 → 抛错 → truthy → 原样回显', () => {
      expect(toDecimalPlaces('abc')).toBe('abc');
    });

    it('null / undefined → 抛错 → falsy → "-"', () => {
      expect(toDecimalPlaces(null as unknown as Decimal.Value)).toBe('-');
      expect(toDecimalPlaces(undefined as unknown as Decimal.Value)).toBe('-');
    });

    it('precision 越界（负数）→ toFixed 抛错 → 回显原值', () => {
      // 注意兜底用的是原始 value 而非格式化结果，所以精度信息整个丢失
      expect(toDecimalPlaces('1.239', -1)).toBe('1.239');
    });
  });
});

describe('toAmountString', () => {
  describe('try 分支：toSignificantDigits —— 注意是「有效数字」不是「小数位」', () => {
    it('precision 作用于有效数字：1.239 取 2 位有效数字得 1.2', () => {
      expect(toAmountString('1.239')).toBe('1.2');
    });

    it('小于 1 的数前导零不计入有效数字', () => {
      expect(toAmountString('0.0001234')).toBe('0.00012');
    });

    it('大数会被有效数字截断成整十整百，量级不变', () => {
      expect(toAmountString('123456')).toBe('120000');
    });

    it('ROUND_UP 在三个量级上都向上进位', () => {
      expect(toAmountString('1.239', 2, Decimal.ROUND_UP)).toBe('1.3');
      expect(toAmountString('0.0001234', 2, Decimal.ROUND_UP)).toBe('0.00013');
      expect(toAmountString('123456', 2, Decimal.ROUND_UP)).toBe('130000');
    });

    it('0 走 try 分支，toFixed() 不补零', () => {
      expect(toAmountString(0)).toBe('0');
    });

    it('NaN / Infinity 走 try 分支', () => {
      expect(toAmountString(Number.NaN)).toBe('NaN');
      expect(toAmountString(Number.POSITIVE_INFINITY)).toBe('Infinity');
    });
  });

  describe('catch 分支', () => {
    it('默认参数 value = "" —— 不传参时直接落进 catch 返回 "-"', () => {
      expect(toAmountString()).toBe('-');
    });

    it('undefined 命中默认值 ""，同样返回 "-"', () => {
      expect(toAmountString(undefined)).toBe('-');
    });

    it('非数字字符串 → 原样回显', () => {
      expect(toAmountString('abc')).toBe('abc');
    });

    it('precision = 0 → toSignificantDigits(0) 抛错 → 回显原值', () => {
      // toSignificantDigits 的合法区间是 1..1e9，0 不合法；
      // 而 toDecimalPlaces 的 precision = 0 是合法的。两个函数边界不一致。
      expect(toAmountString('1.239', 0)).toBe('1.239');
    });
  });
});

describe('toAmountFloor / toAmountCeil', () => {
  it('toAmountFloor 固定 ROUND_DOWN，等价于 toAmountString 显式传 ROUND_DOWN', () => {
    expect(toAmountFloor('1.239')).toBe('1.2');
    expect(toAmountFloor('1.239')).toBe(
      toAmountString('1.239', DEFAULT_USER_PRECISION, Decimal.ROUND_DOWN),
    );
  });

  it('toAmountCeil 固定 ROUND_UP', () => {
    expect(toAmountCeil('1.231')).toBe('1.3');
    expect(toAmountCeil('1.231')).toBe(
      toAmountString('1.231', DEFAULT_USER_PRECISION, Decimal.ROUND_UP),
    );
  });

  it('两者对同一输入方向相反，这是它们唯一的区别', () => {
    expect(toAmountFloor('1.25')).toBe('1.2');
    expect(toAmountCeil('1.25')).toBe('1.3');
  });

  it('precision 透传', () => {
    expect(toAmountFloor('1.239', 3)).toBe('1.23');
    expect(toAmountCeil('1.231', 3)).toBe('1.24');
  });

  it('undefined 走 toAmountString 的默认值分支', () => {
    expect(toAmountFloor(undefined)).toBe('-');
    expect(toAmountCeil(undefined)).toBe('-');
  });
});

describe('isEmptyAmount', () => {
  it('小于 1 个最小精度单位的正数视为空', () => {
    // 0.001 * 10^2 = 0.1 → trunc → 0
    expect(isEmptyAmount('0.001')).toBe(true);
  });

  it('恰好等于一个最小精度单位不算空（边界值）', () => {
    // 0.01 * 10^2 = 1 → trunc → 1
    expect(isEmptyAmount('0.01')).toBe(false);
  });

  it('0 视为空', () => {
    expect(isEmptyAmount(0)).toBe(true);
  });

  it('负的极小值也视为空（trunc 朝零取整）', () => {
    expect(isEmptyAmount('-0.001')).toBe(true);
  });

  it('precision 越大越不容易判空', () => {
    expect(isEmptyAmount('0.001', 2)).toBe(true);
    expect(isEmptyAmount('0.001', 3)).toBe(false);
  });

  it('NaN / Infinity 不判为空', () => {
    expect(isEmptyAmount(Number.NaN)).toBe(false);
    expect(isEmptyAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('⚠️ 无 try/catch：非法输入直接抛 DecimalError，与同文件其他函数的兜底行为不一致', () => {
    // 这是实现上的健壮性缺口，不是本测试的期望行为。
    // 调用方传到非法值时会崩，而不是像 toAmountString 那样拿到 "-"。
    expect(() => isEmptyAmount('abc')).toThrow(/Invalid argument/);
    expect(() => isEmptyAmount('')).toThrow(/Invalid argument/);
    expect(() => isEmptyAmount(null as unknown as Decimal.Value)).toThrow(
      /Invalid argument/,
    );
  });
});

describe('toSimpleAmount', () => {
  it('先按小数位截断再按有效数字截断 —— 两次舍入叠加', () => {
    // toDecimalPlaces('1.239', 2) = '1.23' → toAmountString('1.23', 2) = '1.2'
    expect(toSimpleAmount('1.239')).toBe('1.2');
  });

  it('第二步固定用 DEFAULT_USER_PRECISION，传入的 precision 只影响第一步', () => {
    // precision=6 → toDecimalPlaces 得 '0.000123' → toSD(2) 得 '0.00012'
    expect(toSimpleAmount('0.0001234', 6)).toBe('0.00012');
    // precision=2 → toDecimalPlaces 先截成 '0.00' → toSD(2) 得 '0'
    expect(toSimpleAmount('0.0001234', 2)).toBe('0');
  });

  it('0 一路走 try 分支', () => {
    expect(toSimpleAmount(0)).toBe('0');
  });

  it('接受 Decimal 实例', () => {
    expect(toSimpleAmount(new Decimal('1.239'))).toBe('1.2');
  });

  it('非法字符串经两层 catch 后原样回显', () => {
    expect(toSimpleAmount('abc')).toBe('abc');
  });

  it('空字符串第一层返回 "-"，第二层拿 "-" 再抛再兜底，仍是 "-"', () => {
    expect(toSimpleAmount('')).toBe('-');
  });
});

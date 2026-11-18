# 燃点 FIRE Planner 计算口径文档

> 引擎版本：`fire-engine.2.1.0-alpha.1`  
> 风险规则版本：`risk-engine.v0.1.0`  
> 最后更新：2026-11-18

---

## 1. 基础假设

| 参数 | 说明 |
|---|---|
| `returnRate` | 主投资组合年化收益率，不包含储备账户利率 |
| `inflationRate` | 年通胀率，作用于未来毛支出 |
| `years` | 现金流测算年限 |
| `principal` | 用户输入的期初可投资本金 |
| `medicalReserve` | 医疗专项储备 |
| `reserveReturnRate` | FIRE 后储备账户年化利率 |
| `sideIncomeMonthly` | 副业被动月收入 |
| `dcaYears` / `dcaMonthly` / `dcaReturnRate` / `dividendYield` | 红利低波定投与股息假设 |
| `dividendEnabled` | 红利定投是否启用；未启用时不参与反推本金与现金流曲线 |
| `dividendMode` | `dividendOnly` 仅领取股息；`dividendPrincipal` 领取股息+本金 |

---

## 2. 支出模型

第 `n` 年毛支出：

```text
GrossExpense(n) = AnnualExpense × (1 + inflationRate) ^ (n - 1)
```

FIRE 后储备利息用于抵扣毛支出：

```text
ReserveOffset(n) = min(GrossExpense(n), AnnualReserveInterest)
PreDividendExpense(n) = GrossExpense(n) - ReserveOffset(n)
DividendOffset(n) = min(PreDividendExpense(n), DividendIncome(n))
NetExpense(n) = GrossExpense(n) - ReserveOffset(n) - DividendOffset(n)
```

储备利息当前按固定名义金额处理，不随通胀自动增长。

---

## 3. 反推投资本金

### 3.1 无储备利息口径

当 `reserveReturnRate = 0` 时：

```text
G = AnnualExpense × (1 - ((1 + inflationRate) / (1 + returnRate)) ^ years)
    / (returnRate - inflationRate)
```

若 `returnRate = inflationRate`：

```text
G = AnnualExpense × years / (1 + returnRate)
```

### 3.2 计入 FIRE 后储备利息

安全垫：

```text
SafetyPad = 0.1 × (ReversePrincipal + MedicalReserve + CashReserve)
```

FIRE 后利息基数：

```text
InterestBase = MedicalReserve + SafetyPad
AnnualReserveInterest = InterestBase × reserveReturnRate
```

有限期限反推本金：

```text
AF = Σ 1 / (1 + returnRate) ^ t，t = 1...years

ReversePrincipal =
  [G - AF × reserveReturnRate × (1.1 × MedicalReserve + 0.1 × CashReserve)]
  / [1 + 0.1 × AF × reserveReturnRate]
```

金鹅永续模式下：

```text
G = AnnualExpense / (returnRate - inflationRate)
AF = 1 / returnRate
```

---

## 4. 完整 FIRE 目标

```text
ReverseBase = ReversePrincipal + MedicalReserve + CashReserve
ReverseFull = ReverseBase × 1.1
```

保守目标：

```text
ConservativeBase = AnnualExpense × 40 + MedicalReserve + CashReserve
Conservative = ConservativeBase × 1.1
```

---

## 5. 储备积累计划

储备积累阶段不计息。

- 住家储蓄：每年可存金额等于当前年度支出，并按通胀递增。
- 副业被动收入：每月金额保持不变。
- 住家 + 副业：两种方式同时使用。

```text
Balance(m) = Σ [HomeSaving(yearIndex) + SideIncome]
yearIndex = floor((m - 1) / 12)
```

---

## 6. 红利低波定投与领取

按月定投、月末投入、月复利：

```text
MonthlyRate = (1 + dcaReturnRate) ^ (1 / 12) - 1

FundValue =
  dcaMonthly × ((1 + MonthlyRate) ^ Months - 1) / MonthlyRate
```

领取起点：

```text
DividendStartYear = min(dcaYears, years)
RemainingYears = years - DividendStartYear + 1
```

仅领取股息：

```text
AnnualIncome = FundValue × dividendYield
```

领取股息+本金：

```text
AnnualIncome = FundValue × dcaReturnRate
              / (1 - (1 + dcaReturnRate) ^ -RemainingYears)
```

红利收入抵扣当年支出，并按现值参与反推本金：

```text
DividendOffset(n) = min(GrossExpense(n), AnnualIncome)

PV(DividendOffset) =
  Σ DividendOffset(n) / (1 + returnRate) ^ n
```

有限期限反推本金、金鹅永续反推本金都会减去该项现值。金鹅永续 + 仅股息模式按无限期现金流折现；股息+本金模式只在测算期内领取，期末归零。

领取金额购买力折算（展示用，按领取起点名义金额折回 FIRE 开始时点）：

```text
PurchasingPowerFactor = 1 / (1 + inflationRate) ^ DividendStartYear

AnnualIncomeReal  = AnnualIncome  × PurchasingPowerFactor
MonthlyIncomeReal = AnnualIncomeReal / 12
```

页面以 `¥名义/¥购买力` 形式展示（如 `¥3,000/¥1,500`），斜杠后为小号字的购买力金额，仅用于和 FIRE 起点支出做直观对比，不参与反推与现金流计算。

---

## 7. 风险规则

风险规则不使用 LLM，所有判断均为确定性规则。

| 规则 ID | 触发条件 |
|---|---|
| `principal.below.required` | 用户本金 < 反推投资本金 |
| `medical.reserve.months.low` | 医疗储备 / 月支出 < 6 |
| `return.rate.high` | 年化收益率 > 10% |
| `forecast.years.short` | 测算年限 < 30 年 |
| `reserve.interest.dependency` | 储备利息 / 年支出 > 25% |
| `dividend.coverage.high` | 月股息 / 月支出 > 50% |
| `dca.return.rate.high` | 定投年化收益率 > 12% |

---

## 8. 可复现要求

1. 每次计算输出 `engineVersion`。
2. 每次风险评估输出 `riskEngineVersion`。
3. JSON 快照包含 `state`、`result`、`risk`、`engineVersions`。
4. CSV 包含毛支出、储备利息抵扣、红利收入、红利抵扣、净支出、实际提取和年末资产。
5. 修改公式时必须同步更新本文档与测试。

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
| `dcaInflationAdjust` | 月定投额是否随通胀逐年递增；关闭时每月固定 |
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

### 3.2 反推本金（模拟求解，保证安全）

反推本金不再用解析折现公式，而是**用与现金流曲线完全相同的模拟引擎二分求解**，从根上保证反推值与曲线口径一致。

给定候选本金 P，其对应的 FIRE 后储备利息与曲线同口径：

```text
SafetyPad(P)   = 0.1 × (P + MedicalReserve + CashReserve)
InterestBase(P)= MedicalReserve + SafetyPad(P)
AnnualReserveInterest(P) = InterestBase(P) × reserveReturnRate
```

逐年模拟（与第 2 节现金流完全一致）：

```text
NetExpense(n) = GrossExpense(n) - ReserveOffset(n) - DividendOffset(n)
Balance(n)    = max(0, Balance(n-1) × (1 + returnRate) - NetExpense(n))
```

期末余额 `Balance(years)` 及「是否曾在某年 Balance 归零」都随 P 单调递增，因此可二分：

- **细水长流（drawdown）**：求使全程不破产的最小 P。收敛点即净支出现值，满足「期间不破产 + 期末恰好归零」。
- **金鹅永续（endowment）**：在 `returnRate > inflationRate` 时，求使测算窗末实际购买力 `Balance(years) / (1+inflationRate)^years ≥ P`、且全程不破产的最小 P。

```text
lo = 0, hi = 足够大的上界
重复 70 次：
  mid = (lo + hi) / 2
  if 以 mid 模拟后「不安全」: lo = mid
  else: hi = mid
ReversePrincipal = hi
```

该口径保证：反推目标作为曲线起点时，细水长流全程不破产且终年归零；金鹅永续本金购买力不下降。旧版解析折现会高估红利抵扣（按毛支出封顶，未按扣除储备利息后的余额封顶），导致本金被低估、中途破产，已弃用。

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

开启 `dcaInflationAdjust` 后，月投额按年通胀逐年递增（第 y 年每月投入随年份上调，月末投入、逐月复利）：

```text
Payment(m) = dcaMonthly × (1 + inflationRate) ^ floor((m - 1) / 12)

FundValue       = Σ Payment(m) × (1 + MonthlyRate) ^ (Months - m)
TotalContributed= Σ Payment(m)
```

末年每月投入 `dcaFinalMonthly = dcaMonthly × (1 + inflationRate) ^ floor((Months - 1) / 12)`。递增后市值、股息与红利抵扣均上升，反推本金相应下降。

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

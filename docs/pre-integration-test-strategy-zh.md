# BotCord 集成测试前自动化测试方案

## 1. 目标

本文档定义 BotCord 在进入真实集成测试和联调测试之前的自动化测试策略。

目标不是单纯增加测试数量，而是建立一套分层、稳定、低成本、可回归的质量防线，让大部分问题在本地开发和 CI 阶段就暴露出来。

适用范围：

- `backend/` FastAPI Hub 与 App API
- `plugin/` OpenClaw TypeScript 插件
- `frontend/` Next.js Web 站点与 API Route

---

## 2. 当前现状

从仓库现状看，三端测试基础并不均衡。

### 2.1 Backend

后端已经具备较强的服务内自动化测试基础：

- 已有大量 `pytest` 测试
- 普遍使用 `httpx.AsyncClient + ASGITransport`
- 已覆盖钱包、订阅、WebSocket、注册、公开接口、Dashboard 等核心能力
- 已存在 `tests/contract/`，说明仓库已经开始引入契约测试思路

当前问题不是“没有测试”，而是：

- 测试层次命名还不够清晰
- 关键状态机虽然有覆盖，但还没有被明确沉淀为统一测试模型
- 契约测试还没有真正成为跨包协作的中心机制

### 2.2 Plugin

插件侧已有较好的单元测试和 mock Hub 集成测试基础：

- 已区分 `unit` 和 `integration`
- 已有 `mock-hub.ts` 作为插件侧 Hub 仿真器
- 已覆盖 client、payment、subscription、directory、config、crypto 等关键模块

当前缺口主要在：

- 与后端契约的一致性保护仍不够强
- 一些复杂业务流仍以场景测试为主，缺更系统的状态矩阵

### 2.3 Frontend

前端已经有一部分 `vitest` 测试，但体系较弱：

- 已有部分 API route 测试
- 已配置 `vitest`
- 当前主要依赖 `npm run build` 作为质量兜底

主要问题：

- UI 组件缺少稳定回归测试
- `src/lib/` 和 `src/store/` 的纯逻辑测试不足
- 前端与后端 API 的字段契约缺少系统性保护

---

## 3. 总体原则

BotCord 不应把大量问题留到集成环境才发现。推荐采用“前移验证”的测试金字塔。

原则如下：

1. 业务规则优先在单元测试中验证
2. 接口行为优先在模块测试中验证
3. 跨包字段约定优先在契约测试中验证
4. 状态流转优先在场景测试中验证
5. 真实集成环境只验证最小闭环，而不是承担大规模回归职责

这意味着：

- 大多数失败应在 `unit/module/contract` 阶段出现
- `integration/e2e` 应该数量少、运行慢但价值高
- CI 必须按层分级执行，而不是只看一个总测试命令

---

## 4. 推荐测试分层

建议将“集成测试前自动化测试”统一分为五层。

### 4.1 Unit Test

定义：只测试纯业务规则，不依赖真实网络、数据库、框架运行时。

适用对象：

- 签名与验签逻辑
- ID 生成逻辑
- payload 映射和格式化
- topic 生命周期规则
- 钱包金额计算
- 订阅计费周期计算
- 前端 store 的状态转换
- 前端工具函数和服务层纯逻辑

要求：

- 不访问真实 DB
- 不发真实 HTTP
- 时间和随机数可控
- 单文件执行时间应非常短

目的：

- 快速锁定规则错误
- 让失败定位到具体业务逻辑，而不是一大串联调链路

### 4.2 Module Test

定义：测试单个模块及其直接边界，依赖可替换为 mock/fake。

适用对象：

- FastAPI router + fake dependency
- Next.js route handler + mocked auth/db/service
- Plugin client/tool + mock Hub
- WebSocket handler + fake transport

要求：

- 验证输入、输出、错误码、鉴权、幂等、分页、边界值
- 不要求真实跨服务部署
- 可以使用内存数据库、fake session、mock client

目的：

- 提前验证接口行为是否符合预期
- 让大部分 API 级回归不需要进入完整联调环境

### 4.3 Contract Test

定义：测试跨包接口约定是否一致，是 BotCord 最关键的一层。

适用对象：

- backend -> plugin 的接口字段
- backend -> frontend 的接口字段
- 错误响应结构
- 可选字段、枚举值、时间格式、分页字段、金额字段

重点接口：

- 注册与 claim/bind
- Hub send / inbox / history
- Wallet summary / ledger / transfer / withdrawal
- Subscription product / subscribe / cancel / renew
- Dashboard overview / room / contact request
- Public overview / rooms / agents

要求：

- 为关键响应定义 schema 或 contract fixture
- 成功响应和失败响应都要校验
- 契约变化必须在 CI 中显式失败

目的：

- 阻止“字段改名但没通知”
- 阻止“nullable 改了但调用方未适配”
- 阻止“枚举扩展导致前端/插件解析崩溃”

### 4.4 Scenario Test

定义：测试核心业务流和状态机，但仍然不要求完整线上集成环境。

适用对象：

- 钱包完整生命周期
- 订阅完整生命周期
- topic open -> result/error -> reopen
- contact request send -> accept/reject
- claim/bind 并发竞争与冲突处理
- gated room 权限流转

要求：

- 使用可复用的 fixture builder / factory
- 用场景矩阵覆盖正常路径、失败路径、重复请求、乱序请求
- 明确断言系统状态，而不只断言 HTTP 200

目的：

- 在较低成本下验证复杂业务流
- 把“会在真实联调里爆炸的问题”提前压住

### 4.5 Smoke Test

定义：少量高价值闭环测试，作为集成测试前最后一道门。

推荐只保留 5 到 10 条：

- agent 注册并 claim
- plugin 鉴权并收发消息
- dashboard overview 成功返回
- wallet topup + transfer
- subscription create + subscribe + gated room join

目的：

- 验证关键闭环没有断
- 不追求覆盖面，只追求关键路径可用

---

## 5. 各包落地建议

### 5.1 Backend

Backend 应维持“单测少耦合，模块测覆盖主接口，场景测覆盖状态机”的结构。

建议目录策略：

- `backend/tests/unit/`
- `backend/tests/module/`
- `backend/tests/contract/`
- `backend/tests/scenario/`
- 保留现有测试文件，但逐步向上述结构收敛

优先补强点：

1. 将纯规则逻辑从 router/service 中抽离，便于单测
2. 为钱包、订阅、topic、claim 建立统一 factory
3. 把现有长测试按状态机场景拆分命名
4. 强化错误响应 contract，而不仅是 happy path

重点关注：

- 幂等键作用域
- 余额不透支
- 并发请求一致性
- 订阅续费重复执行保护
- WebSocket 通知时序
- subscription-gated room 权限边界

### 5.2 Plugin

Plugin 当前方向基本正确，应继续强化与 Hub 协议层的稳定性。

建议目录策略：

- `plugin/src/__tests__/unit/`
- `plugin/src/__tests__/contract/`
- `plugin/src/__tests__/scenario/`
- 保留 `mock-hub.ts` 作为插件测试核心基础设施

优先补强点：

1. 给 client 的关键返回体增加 contract 断言
2. 对 payment / subscription / directory 的失败分支补矩阵
3. 为 token refresh、重试、重放保护建立更清晰的场景集
4. 对 topic、session、message dispatch 建立状态流测试

重点关注：

- 鉴权过期后的恢复
- 失败重试是否导致重复写入
- Hub 字段变化是否导致插件崩溃
- 本地配置文件与多账号模式的回归稳定性

### 5.3 Frontend

Frontend 是当前最需要补体系的一端。

建议目录策略：

- `frontend/tests/unit/`
- `frontend/tests/api/`
- `frontend/tests/contract/`
- `frontend/tests/scenario/`

优先补强点：

1. `src/lib/` 的纯逻辑测试
2. `src/store/` 的状态转换测试
3. 所有关键 API route 的 route-level 测试
4. Dashboard 关键组件的最小渲染/交互测试
5. 前端消费 backend 字段的 contract 测试

重点关注：

- 认证失败和 agent 缺失分支
- 列表分页与空态
- 金额、时间、状态枚举的展示逻辑
- dashboard overview、wallet、subscriptions、contact requests、agents claim/bind

说明：

前端不应继续主要依赖 `npm run build` 作为自动化测试替代品。构建通过只能说明代码可编译，不能说明行为正确。

---

## 6. 契约测试策略

对于 BotCord，这一层必须成为跨包协作的核心机制。

### 6.1 推荐做法

以 backend 为 source of truth：

- 优先输出 OpenAPI 或关键 response schema
- 对核心接口维护稳定的 contract fixture
- plugin 和 frontend 都基于同一份 contract 做校验

### 6.2 必须纳入 contract 的内容

- 必填字段
- 可选字段
- nullable 语义
- 枚举值
- 时间字段格式
- 金额字段格式
- 分页字段
- 错误响应结构

### 6.3 contract 变更规则

任何 contract 变更都必须：

1. 修改 schema 或 contract fixture
2. 修改对应调用方测试
3. 在 PR 描述中说明是否存在破坏性变更

否则不允许合并。

---

## 7. 场景测试策略

BotCord 的复杂性不在页面，而在状态机和协议交互。场景测试应重点围绕以下领域建立。

### 7.1 Wallet

至少覆盖：

- topup create -> complete
- transfer success / insufficient balance / self transfer
- withdrawal create / approve / reject / cancel
- idempotency protection
- concurrent transfer no overdraft

### 7.2 Subscription

至少覆盖：

- create product
- subscribe success
- first charge success
- recurring renewal
- duplicate renewal skip
- repeated failure -> cancel / past_due
- gated room access grant / revoke

### 7.3 Topic Lifecycle

至少覆盖：

- message 创建 topic
- result 完成 topic
- error 失败 topic
- completed/failed 后无新 goal 不自动回复
- 带新 goal 时 reopen

### 7.4 Claim / Bind

至少覆盖：

- 未登录
- claim code 不存在
- 已被他人认领
- 并发竞争导致 0 rows affected
- hub 存在但本地未镜像

---

## 8. CI 分层门禁

建议在 CI 中分阶段执行，而不是一个大命令全部跑完。

### 8.1 PR 必跑

- Backend unit + module
- Plugin unit + scenario-lite
- Frontend unit + api
- Contract test
- Type check / build

建议命令方向：

- `cd backend && uv run pytest tests/ -m "not contract"`
- `cd plugin && npm test`
- `cd plugin && npx tsc --noEmit`
- `cd frontend && npm test`
- `cd frontend && npm run build`

### 8.2 Main 分支必跑

在 PR 基础上增加：

- backend scenario
- plugin scenario
- frontend scenario
- smoke tests

### 8.3 Nightly / Pre-release

运行更慢、更接近真实环境的测试：

- live contract
- full integration
- end-to-end
- 回归矩阵

---

## 9. 优先级最高的首批建设项

如果资源有限，建议先做以下十项，收益最高。

1. 为 backend 核心响应建立统一 contract schema
2. 为 frontend API route 建立统一测试模板
3. 为 frontend `src/store/` 增加状态测试
4. 为 plugin client 响应增加 contract 断言
5. 抽象 wallet factory
6. 抽象 subscription factory
7. 抽象 agent/room factory
8. 将 topic lifecycle 拆成明确状态机场景集
9. 在 CI 中拆分 `unit/module/contract/scenario`
10. 建立 5 到 10 条稳定的 smoke 测试

---

## 10. 不建议的做法

以下做法应避免：

- 过度依赖完整集成环境发现问题
- 只看覆盖率，不看状态机和错误路径
- 前端只依赖 `build`
- contract 变化只靠口头同步
- 写大量超长 happy path 测试但缺少失败分支
- 在测试中大量复制 setup 代码而不抽 factory

---

## 11. 推荐里程碑

### 里程碑一：测试分层收敛

目标：

- 统一命名和目录
- 明确什么属于 unit/module/contract/scenario

### 里程碑二：契约测试落地

目标：

- backend 输出关键 contract
- frontend/plugin 共享同一份契约基线

### 里程碑三：核心状态机场景化

目标：

- wallet
- subscription
- topic
- claim/bind

### 里程碑四：CI 门禁成型

目标：

- PR、main、nightly 三层执行策略稳定运行
- 测试结果可观察，可定位

---

## 12. 最终判断

BotCord 当前并不是“缺测试”，而是“缺少统一的测试架构”。

真正应该补的不是更多零散 case，而是三件事：

- 前端测试体系化
- 跨包契约测试中心化
- 核心状态机场景化

这三件事完成后，集成测试的职责会发生变化：

- 现在的集成测试主要在“帮你们找功能问题”
- 未来的集成测试应该主要在“确认真实环境没有偏离预期”

这才是一个多包协议型项目应有的自动化测试结构。

# RFC 0004：变更智能

[English](0004-change-intelligence.md)

- 状态：M2-00 已接受
- 里程碑：M2-00 / M2-01 / M2-02 / M2-03 / M2-04 / M2-05
- 更新时间：2026-09-01

## 摘要

变更智能比较两个不可变的 `CompilationSnapshot`。Core 只接收 Snapshot；它不读取 Git、不执行配置
文件、不生成 Backend 产物，也不决定组织级 policy。比较结果记录版本化语义事实、精确 Context
覆盖、base/head 两侧 Graph 影响并集、建议性的 rename candidate，以及 Backend plan 变化。

`SnapshotDiffV1` 是比较事实的权威来源。Impact Report v1 是 CLI 使用的“source 或 Token 到受影响
Token”信封。JSON 是权威格式；文本与 SARIF 都是确定性投影。输入非法或 Context 覆盖因界限而不完整
时，结果必须明确为 incomplete，绝不能伪装成成功的空 diff。

M2-00 只冻结设计、fixture、Schema 草案和性能基线，明确不增加生产命令或公开 Core 类型。

## 用户问题

原始 JSON/Git diff 无法回答解析后的 Token 值是否变化、哪些消费者受影响、两个 Context 分支是否
重叠，或 Backend 是否改变了导出 symbol。反过来，只遍历单侧 Snapshot 的反向 usage，会漏掉只存在于
另一个 revision 的消费者。CI 还必须区分“完整且通过 policy”和“根本无法完整比较”。

结果也必须服务于继续使用其他生成器的团队，因此 tokenc 可以报告语义事实，而不必接管产物写入、
Git checkout 状态或发布 policy。

## 决策

### 1. Core 比较两个已发布 Snapshot

未来的 Core 入口只接受两个已构建 Snapshot 与显式选项：

```ts
compareSnapshots(
  base: CompilationSnapshot,
  head: CompilationSnapshot,
  options?: SnapshotComparisonOptions,
): Promise<SnapshotDiffV1>;
```

Snapshot 构建、文档获取和 revision label 都属于宿主。比较不得修改任一 Snapshot，且必须返回深度
不可变、可 JSON 序列化的结果，其中不能含 compiler、`Map`、`Set`、callback 或 Backend 私有 payload。

`SnapshotIdentityV1` 记录调用方提供的 revision label，以及 Snapshot 的 `sourceRevision`、
`configurationIdentity` 和有效状态。label 只用于展示；Snapshot 字段才是语义身份。

### 2. 事实、建议与 policy 分离

Token 事实采用以下 v1 kind：

| Kind                | 含义                                                                |
| ------------------- | ------------------------------------------------------------------- |
| `added` / `removed` | 规范 Token ID 只存在于一侧。                                        |
| `direct-value`      | Token 自身选中的表达式或 literal 发生变化。                         |
| `propagated-value`  | 本 scope 内没有直接值编辑，但解析值发生变化。                       |
| `type`              | 声明或推导的语义类型变化。                                          |
| `metadata`          | DTCG metadata 或保留的扩展数据变化。                                |
| `dependency`        | dependency target、kind、field path、occurrence 或 condition 变化。 |
| `context-coverage`  | Token/candidate 存在或胜出的 Context 集合变化。                     |

一个 Token 可以同时具有多种事实。例如修改 alias target 可以产生 `dependency` 与 `direct-value`；
其消费者还可单独产生 `propagated-value`。事实中绝不包含 breaking/non-breaking 判定。

`direct-value` 比较规范化后的选中 source expression；`propagated-value` 比较 resolved value，并排除
该 scope 中已有直接 expression 变化的情况。`metadata` 包括 `$description`、deprecation 数据和保留的
非语义 extension；已识别的 Context/Resolver extension 属于语义输入，按各自专门类别归类。

Rename 识别只是建议，放在 `changes` 外的 `renameCandidates`。每个 candidate 配对一个 removed 和
一个 added。candidate 必须具有相同规范 type，并只根据严格 canonical 证据计分：全部已比较 coverage
中的 resolved value（0.45）、metadata（0.10）、替换 candidate pair 后的 dependency（0.20）、type
（0.20），以及仓库相对 document 与 parent path proximity（0.05）。低于 0.75 的 candidate 被丢弃；
只有同时作为两个 endpoint 的唯一最高分时才是 `unambiguous`，其余仍存活的并列项全部输出为
`ambiguity: "ambiguous"`。不使用 edit-distance 或概率匹配。Core 不会暗中把 add/remove 事实转换为
rename。

Backend 事实只包括 `symbol` 与 `artifact-path`，且仅来自成功的 `prepare()`。比较绝不调用 `emit()`，
也不把渲染后文件字节当作语义身份。

配置变化通过 base/head configuration identity 记录在 report 顶层。如果在可信配置下无法覆盖其
语义效果，比较结果就是 incomplete。

### 3. 稳定身份与确定性顺序

每项变化都有 `changeId`：对包含 schema version、kind、规范 Token ID、规范 Context predicate 和可用的
before/after 语义 anchor 的 canonical JSON 计算 SHA-256 base64url。message、绝对路径、展示用
line/column、timing、policy severity 和 rename score 不参与身份。

数组具有规范顺序：

1. 规范 Token ID；
2. 上表中的 change kind 顺序；
3. 规范 Context predicate key；
4. before document/offset，再按 after document/offset；
5. 最后以 `changeId` 打破并列。

Impact 按 Token ID 和 predicate key 排序；Backend fact 按 Backend ID、Token ID、artifact identity、kind
排序；rename candidate 按 removed ID、evidence score 降序、added ID 排序。Diagnostic 沿用 v1 顺序。

JSON object 成员顺序不属于协议，但仓库 serializer 会固定输出顺序，使重复运行字节一致。

### 4. Context 覆盖必须显式且有界

比较请求使用规范 predicate 表示，而不是隐式笛卡尔积。`coverage.compared` 记录完整检查过的
predicate；`coverage.omitted` 记录每个未覆盖 predicate，并使用以下 reason：

- `limit-exceeded`
- `invalid-base`
- `invalid-head`
- `configuration-unavailable`
- `backend-prepare-failed`
- `unsupported`

只有 `coverage.omitted` 为空且全部必要语义阶段成功时，`status` 才能为 `complete`。单个精确 Context
比较可使用完整 Context；多 Context 工作必须使用惰性 iterator 和调用者提供的 limit。达到 limit 是数据，
不能被推断成“没有变化”。

互斥 predicate 绝不互相传播 impact。交集、并集、可满足性与排序只使用现有 canonical predicate algebra。

### 5. 完整 impact 必须遍历两侧 Graph

Impact 是 base 与 head Graph 中反向遍历结果的条件感知并集：

```text
base changed roots ──base 反向 usages──┐
                                       ├── predicate 并集 ──> combined impact
head changed roots ──head 反向 usages──┘
```

只遍历 head 会漏掉被删除的 dependency。若 base 中存在
`component → semantic → primitive`，head 删除了 `component → semantic`，那么修改 `semantic` 仍然影响
旧 component，迁移审查必须看到它。只遍历 base 则会对称地漏掉新消费者。因此 changed root 必须在其
存在的每一侧遍历，然后按 Token ID 合并，同时保留 side provenance 和规范 predicate 并集。

`directlyAffected` 表示在任一侧与 changed root 相距一条 incoming dependency edge；
`indirectlyAffected` 表示相距两条或更多边，并排除 changed/direct entry。directness 先逐侧计算再求并集，
避免路径删除让旧的 direct consumer 被错误降级为 indirect 或缺失。

### 6. 非法 Snapshot 与部分证据采用 fail-closed

非法 base/head 仍可查询 M1 能提供的 Graph 事实，但 resolved-value 与 Backend fact 不可用。结果必须：

- 设置 `status: "incomplete"`；
- 保留仍可可靠确定的 structural/Graph fact；
- 记录 omitted coverage，以及带 side 的原始 Diagnostic v1；
- 不报告 unchanged、policy pass 或依赖不可用证据的完整 rename 结论。

预期用户错误使用结构化 Diagnostic。比较代码不变量或 Backend contract 违反仍作为异常，并让命令按
内部错误失败。

### 7. Git 与配置留在 Core 之外

CLI/CI revision provider 将 Git object 读取为隔离的虚拟文档集。与 `worktree` 比较时，在虚拟层叠加
scope 内 tracked、modified、deleted 和 untracked 文件，不执行 checkout、stash、index 写入、branch
移动或仓库配置修改。临时路径绝不进入 document identity 或 report path。

只有当前可信 invocation 选择的配置可以执行。base/head 中历史 JavaScript/TypeScript 配置只是数据，
绝不能被静默 import 或 evaluate。provider 可以：

1. 对两侧使用同一份显式可信的当前配置，并报告此 scope；
2. 接受声明式、经 Schema 校验的历史配置格式；或
3. 以 `configuration-unavailable` 将比较标为 incomplete。

configuration identity 变化必须始终可见。未来即使支持历史代码执行，也必须有单独的显式 trust flag
和进程隔离；这不属于 M2。

### 8. Backend 比较止于 preparation

对每个已配置 Backend，两个有效 Snapshot 都只调用现有公开 `prepare()` 边界。diff 比较已分配 symbol
identity 和规划的 artifact identity/path，并保留全部 plan Diagnostic。绝不调用 `emit()`，因此变更智能
不会写文件，也不会触发 Backend 渲染副作用。

不透明 naming callback 会让 Backend plan 默认不可跨 revision 缓存。只有当 callback 属于显式可信的
当前配置时才能执行。plan 失败或不可用时，相关 Backend coverage 标为 incomplete，而不是伪装成无变化。

### 9. Policy 消费事实，不能改写事实

Breaking-change policy 是后续建立在 `SnapshotDiffV1` 上的独立层。它可以分配 severity、allow 特定
`changeId`、按 Context 限定 rule，并产生 finding；但不能增删 change、改变 coverage、重分类 rename
candidate，或把 incomplete 证据变成 pass。

默认 policy 将使用独立的版本化契约。把 policy 与 Core 比较分开，允许两个组织基于字节完全一致的语义
事实做出不同发布判断。

### 10. JSON 是权威格式；Text 与 SARIF 是投影

Snapshot Diff v1 与 Impact Report v1 都拥有仓库管理的 JSON Schema。Text、JSON 与 SARIF renderer 只
消费一个不可变 report model，不执行编译、Graph 遍历、Backend preparation 或 policy evaluation。

SARIF 将有 source 的 Diagnostic 与 policy finding 映射为 rule/result。Diagnostic fingerprint 写入
`partialFingerprints`；规范的仓库相对 document 成为 artifact URI；related location 与有效 fix 原样保留。
没有 source-backed finding 的普通 Token change 只存在于 JSON/text，不能被伪造成 SARIF error。

宽容 reader 忽略未知 object field；缺失必填字段或未知 major `schemaVersion` 必须拒绝。

### 11. Exit code 区分 finding 与 incomplete

| Code | 含义                                                                     |
| ---- | ------------------------------------------------------------------------ |
| `0`  | 编译与比较完成；启用的 policy 没有失败 finding。                         |
| `1`  | 比较完成，但 compiler diagnostic 或 policy finding 使调用失败。          |
| `2`  | 获取或比较不完整，包括必要 Snapshot 非法、可信配置不可用或覆盖达到界限。 |

内部异常也可退出 `2`，并尽可能在 stderr 输出内部诊断。如果 policy failure 与 incomplete coverage 同时
出现，`2` 优先，因为此时无法给出完整 verdict。

## Schema 草案与 fixture

M2-00 将未导出的 Schema 草案放在 `docs/schemas/drafts/`，example 放在
`docs/schemas/examples/`。fixture 权威文件为
`benchmarks/fixtures/change-intelligence/matrix.v1.json`，它把每个 taxonomy 项与 failure state 映射到
拟议 v1 字段。分层 fixture generator 与受版本控制的 expectation 描述 1,200 个 Token，覆盖 primitive、
semantic、component 三层与两个 Context 维度。

这些草案在 M2-01 期间可以不承诺兼容地修改。只有完成实现、Schema validation、确定性 golden test 和
contract manifest 登记后，才会成为公开契约。

## 进入 M2-01 前的 Gate checklist

| Gate                 | 结论                                                       | 必需证据                                      |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------- |
| 可信配置             | 历史可执行配置绝不隐式运行。                               | 不可信配置 fixture 产生 incomplete coverage。 |
| Git worktree overlay | object read 加虚拟 overlay；不改 checkout/index/config。   | 临时仓库前后状态 hash。                       |
| 稳定身份             | canonical hash 输入与排序已在上文固定。                    | 重复运行与反向比较测试。                      |
| Rename 歧义          | candidate 只作建议，并列显式保留。                         | 明确与歧义 rename fixture。                   |
| 不完整覆盖           | omitted predicate/reason 是一等数据并 fail closed。        | invalid-side 与 limit fixture。               |
| Exit code            | `0` 通过、`1` finding、`2` incomplete/internal；`2` 优先。 | CLI matrix test。                             |
| SARIF 映射           | 只映射 source-backed finding；fingerprint/location 一致。  | 跨格式 golden 与 SARIF 2.1.0 校验。           |

## 性能基线

M2-00 benchmark 在比较引擎出现之前测量当前公开原语：

- unchanged 双 Snapshot 构建；
- 分层项目单文件编辑及 base/head impact 并集；
- high fan-out impact 遍历；
- 确定性 report 序列化；
- Backend preparation、序列化 report 字节数与隔离进程 peak RSS。

fixture 创建与文件系统 IO 不进入计时区。语义 counter 和 hash 是门禁；跨机器 wall time 在拥有相同环境
基线前只作参考。

## 测试计划

- 校验 fixture manifest 覆盖全部 taxonomy kind、Backend fact、配置变化、非法 side、rename 歧义和
  互斥 Context 行为。
- 断言 1,200 Token 分层 generator 的精确 Token/reference 数量与 direct/transitive impact predicate。
- 校验 draft example 满足两个 Schema 的结构要求。
- 为四个 M2-00 benchmark case 记录确定性 semantic hash 与有限的 timing/memory 值。
- M2-01 增加 empty、inverse、base-only edge、head-only edge 和 Context differential 测试。
- M2-03 至 M2-05 按 Gate checklist 增加仓库不变性、exit code、policy 与跨格式一致性矩阵。

## 拒绝的方案

- **直接 diff source JSON：** 会丢失 resolved value、胜出 candidate、conditional edge 与 Backend
  allocation fact。
- **只遍历 head Graph：** 会漏掉被删除的 consumer 与 dependency。
- **把 rename 当作事实：** 存在歧义时，没有用户确认并不安全。
- **为追求还原度执行每个 revision 的配置：** 历史代码不可信，并能执行任意宿主 IO。
- **允许 policy 就地注释或过滤 diff：** 会破坏事实的可复用 identity。
- **以 SARIF 作为规范模型：** SARIF 面向 finding，无法忠实表示所有中立语义变化或 incomplete Context。
- **物化全部 Context permutation：** 违反有界惰性求值，并可能指数增长。
- **生成 Backend 输出后再比较：** 引入副作用，并混淆 plan identity 与 renderer 格式。

## 开放问题

Gate 0 没有开放问题。在 M2-01 导出公开契约前，字段拼写只有在同步更新本 RFC、两份 Schema 草案、
example 和 fixture matrix 时才能改变。

## 明确不做

- M2-00 不实现生产版 `tokenc diff` 或 `tokenc impact` 命令。
- M2-00 不公开导出 `SnapshotDiffV1` 或 Impact Report v1。
- Core 不执行 breaking-change policy、SARIF 渲染或 Git 获取。
- 不自动应用 rename 或 source edit。
- 比较期间不生成 artifact。
- 不承诺兼容未发布的草案形状。

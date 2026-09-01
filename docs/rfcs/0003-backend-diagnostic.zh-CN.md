# RFC 0003：Backend Plan 与 Diagnostic v1

[English](0003-backend-diagnostic.md)

- 状态：已接受
- 里程碑：M1-02 / M1-05 / M1-06
- 更新：2026-08-30

## 摘要

Backend 从 `validate(compilation) + emit(compilation)` 改为两个纯阶段：`prepare(ir) → BackendPlan` 和
`emit(plan) → OutputFile[]`。Plan 在任何 emit 前确定 capability、symbol 和 artifact path；所有 Backend
plan 合并后统一 preflight，任一错误都会阻止全部 emit。

所有阶段使用版本化 `Diagnostic v1`：稳定 code、结构化参数、语义 source anchor、确定性 fingerprint、
documentation URL、related location 与可选 workspace edit。此契约直接替换现有接口，不保留旧 Backend
或 Diagnostic 形状。

## 用户问题

当前 Backend 分别实现名称分配和值能力检查，`validate()` 不能声明完整 artifact plan，而跨 Backend 路径
碰撞要等 `emit()` 已生成内容后才发现。第三方 Backend 没有可测试的 conformance contract。

当前 Diagnostic 有 code、message、location 和 suggestion，但没有 schema version、稳定 fingerprint、文档
链接或机器可应用 edit。CLI JSON 只是临时映射，冷编译与增量客户端无法可靠去重同一问题。

## Backend 决策

### 1. 只读 IR 与两阶段契约

```ts
interface TokenBackend<Options, Plan extends BackendPlan> {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  prepare(input: Readonly<CompilationIR>, options: Readonly<Options>): Promise<Plan> | Plan;
  emit(plan: Plan): Promise<readonly OutputFile[]> | readonly OutputFile[];
}

interface BackendPlan {
  readonly backendId: string;
  readonly diagnostics: readonly DiagnosticV1[];
  readonly symbols: readonly AllocatedSymbol[];
  readonly artifacts: readonly PlannedArtifact[];
}
```

IR 是已检查、不可变、Backend-neutral 的事实；Backend 不可访问 Parser、可变 Graph 或 Resolver。
`prepare` 必须完成所有可预期验证，Plan 包含 emit 所需的全部已归一化数据。`emit` 不得重新命名、重新解析
Token、增加 artifact、读取环境或产生 Diagnostic；它只能确定性渲染 Plan。emit 抛出被视为 Backend bug，
整次内存结果被丢弃。

### 2. Capability negotiation

```ts
interface BackendCapabilities {
  readonly tokenTypes: ReadonlySet<TokenType>;
  readonly referenceStrategies: ReadonlySet<ReferenceStrategy>;
  readonly contextMode: "none" | "finite-selectors" | "runtime";
  readonly colorSpaces: "preserve" | ReadonlySet<ColorSpace>;
  readonly composite: "native" | "serialized-subset" | "none";
}
```

Core 在调用 `prepare` 前校验静态 capability；Backend 在 `prepare` 中校验依赖 options 的细粒度表达能力。
无法无损表示必须产生 `BACKEND_UNSUPPORTED_VALUE` 或更具体的 registry code，不能 stringify 未知对象、
静默丢字段或隐式转换颜色空间。Capability 是声明，不是允许 Backend 修改 IR 的 hook。

### 3. 共享 Symbol Allocator

Backend 为每个 Token 提交 symbol request，而不是自行碰撞检测：

```ts
interface SymbolNamespace {
  readonly name: string;
  readonly caseSensitive: boolean;
  readonly normalize: "NFC" | "NFKC";
  readonly reserved: ReadonlySet<string>;
  readonly pattern: RegExp;
}
```

Allocator 按 namespace 分配，依次执行 Unicode normalization、大小写折叠（若需要）、pattern、保留字与
碰撞检查。碰撞诊断同时指向两个 Token 和命名请求。默认不追加序号；用户必须通过显式 rename map 或 naming
policy 消除冲突。相同 Token 在不同 namespace 可使用相同字符串。

用户 naming callback 视为不透明代码：每次 prepare 调用，默认不可缓存。callback throw 转换成
`BACKEND_NAMING_FAILED`，位置指向 Token，不发布部分 symbol table。

### 4. Artifact planning 与全局 preflight

`PlannedArtifact` 在 emit 前声明 backend ID、规范化相对路径、media type、来源 Token（若有）和 Backend
私有 render payload。路径必须相对 output root，不能为空、绝对、包含 `..` 逃逸或 NUL。

所有 Backend prepare 完成后，Core 合并 plan 并执行：

- 按 NFC + case-fold 的最严格公共文件系统规则检查全局路径碰撞；
- 检查同一 Backend 重复 artifact、output root 逃逸和非法路径；
- 聚合 capability、symbol、value 与 path diagnostics；
- 只有所有 plan 无 error 时才调用任何 Backend 的 emit。

emit 返回的文件集合及路径必须与 plan 一一对应，否则抛出 `BackendContractError`，丢弃所有 output。Core
只返回内存 `OutputFile`；CLI 负责以临时文件/rename 策略原子物化到磁盘。

## Diagnostic v1 决策

### 1. 公共结构

```ts
interface DiagnosticV1 {
  readonly schemaVersion: "1";
  readonly code: DiagnosticCode;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly fingerprint: string;
  readonly documentationUrl: string;
  readonly source?: DiagnosticLocation;
  readonly related: readonly RelatedDiagnosticV1[];
  readonly fixes: readonly DiagnosticFixV1[];
}

interface DiagnosticLocation {
  readonly document: string;
  readonly range: SourceRange;
  readonly anchor?: SemanticAnchor;
}
```

所有数组存在但可以为空，避免 serializer 依调用方省略字段。`message` 面向人类，不能作为身份或控制流。
`parameters` 使用 registry 为每个 code 定义的固定 key。`documentationUrl` 指向带 code anchor 的版本化文档。

### 2. Code registry 与 fingerprint

Core 维护 code registry，记录 owner stage、默认 severity、参数 schema、文档 anchor 和是否允许 fix。Backend
使用 `BACKEND_*` namespace，Session 使用 `SESSION_*`；第三方 Backend 使用反向域名 namespace，不能注册
Core code。

Fingerprint 是以下 canonical JSON 的 SHA-256 base64url：

```text
schemaVersion, code, canonical document identity,
semantic anchor (token/candidate/field path or JSON pointer),
registry-declared identity parameters
```

message、severity、显示 range、related、fix、绝对 cwd 和 timing 不参与 fingerprint。没有 semantic anchor 的
parse error 使用 canonical document identity、parser error kind 和原始 token offset 作为 fallback。同一 source
revision 的冷编译与增量编译必须得到相同 fingerprint；无保证在问题本身被移动或改写后保持相同。

### 3. Fix edit 与序列化

```ts
interface DiagnosticFixV1 {
  readonly title: string;
  readonly applicability: "safe" | "requires-review";
  readonly edits: readonly TextEdit[];
}
```

一个 fix 内 edit 必须按 canonical document/range 排序、互不重叠，并携带 expected document content digest，
防止应用到过期文本。Core 只提供 edit，不写文件。纯文字建议若不可机械应用，保留为 related/documentation，
不伪装成 fix。

JSON 输出固定顶层 `{ "schemaVersion": "1", "diagnostics": [...] }`，字段顺序不属于协议，但数组顺序稳定。
未知字段必须被消费者忽略；缺少必需字段或未知 major schemaVersion 必须拒绝。M1 期间直接替换旧 CLI JSON，
不提供双格式开关。

## 失败模式与诊断

- 不支持类型/值/引用策略：`BACKEND_UNSUPPORTED_*`，指向 Token/occurrence。
- symbol 非法、保留或碰撞：`BACKEND_SYMBOL_*`，碰撞带双方位置。
- artifact 路径非法或碰撞：`BACKEND_ARTIFACT_*`，跨 Backend 带双方 plan owner。
- Backend callback 可预期失败：结构化 `BACKEND_*_FAILED`。
- Backend 违反 plan-to-emit 契约：抛 `BackendContractError`，不伪装成用户 source Diagnostic。
- Diagnostic registry 构造参数错误：开发期 assertion/test failure，不发布畸形 Diagnostic。

## 增量失效

- Diagnostic fingerprint 与生成模式无关；冷构建和 Session 使用同一 registry factory。
- IR revision 或 Backend options 变化使 plan 失效；Graph source-range-only 变化只更新 plan provenance。
- symbol request 变化重新分配所属 namespace；实现可以复用未变化请求，但结果必须等同于全量分配。
- 任一 artifact path 变化重跑全局 path preflight。
- Backend plan 默认不缓存；只有 Backend 提供覆盖 options、版本和所有 callback 行为的稳定 key 才能缓存。

## 公共 API 变化

- 删除 `TokenBackend.validate` 和 `TokenBackend.emit(compilation)`。
- 删除 `backendNameCollisionDiagnostics`；共享 Allocator 是唯一 symbol authority。
- `emit` 只接收已成功 preflight 的 BackendPlan。
- 现有 `Diagnostic` 和 CLI JSON 直接替换为 Diagnostic v1。
- 内置 CSS、Tailwind、TypeScript Backend 在同一个 M1-06 变更中迁移，第三方 Backend 必须同步更新。

## 测试计划

- Backend conformance suite：capability、symbol、value、context 和 artifact failure 均发生在 emit 前。
- spy Backend 证明任一 plan error 或跨 Backend 路径碰撞时，所有 emit 调用数为零。
- plan-to-emit 一致性：缺文件、多文件、额外文件和路径改变均为 contract error。
- Allocator property tests：Unicode normalization、大小写、保留字、非法首字符、确定性排序和 rename map。
- Diagnostic JSON schema fixture、registry 完整性、稳定排序和未知字段行为。
- cold/incremental fingerprint equality；修改 message/range 不改变 fingerprint，修改 identity 参数会改变。
- fix edit 的 digest、排序、重叠与跨文件测试。
- 内置 Backend golden output 与现有 M0 failure fixture 不回归。

## 开放问题

无。评审若否决某项决定，必须在本节记录替代决定及理由后才能接受 RFC。

## 明确不做

- 不让 Backend 修改 IR 或执行任意 transform pipeline。
- 不自动追加不稳定 symbol 后缀。
- 不在 Core 写 artifact 到磁盘。
- 不把 Backend bug 转成可忽略 warning。
- 不承诺 Diagnostic v0 或旧 Backend API 兼容。
- 不在 M1 实现 SARIF、PR annotation 或本地化 message；它们可消费 Diagnostic v1。

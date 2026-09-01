# 架构设计

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

`tokenc` 使用编译器架构组织 Design Token：DTCG JSON 是源代码，Token Graph 是语义模型，Context Resolution 是求值过程，Type Checker 负责静态分析，Backend 则是代码生成器。

## 编译流水线

```text
DTCG 2025.10 Token 文档
  → 可选 DTCG Resolver Source Composition
  → Syntax Parser + Unresolved Source Model
  → Reference Linking（Curly Alias、JSON Pointer $ref、Group $extends）
  → Reference-driven Type Resolution
  → typed TokenNode[] + structured diagnostics
  → TokenGraph
  → Context validation + reference type checking
  → lazy TokenResolver
  → immutable CompilationIR
  → TokenBackend.prepare(ir) → BackendPlan
  → 全局 capability、symbol 与 artifact preflight
  → TokenBackend.emit(plan)
  → OutputFile[]
```

高层 `compile()` API 负责加载文件并执行完整流水线；`compileDocuments()` 接受虚拟输入。Core 中的任何阶段都不会直接写入输出文件或终止进程。

## 单一源语言

DTCG 2025.10 是 tokenc 刻意保留的唯一编译器源语言。配置中没有启用专有语法的开关，因此 Parser、Graph、Resolver、Checker 与 Backend 始终工作在一套定义明确的语言模型上。非 DTCG Token 格式必须在编译前完成转换。

DTCG 版本仍会明确出现在校验、诊断、Resolver 文档与说明中，但不作为用户可选的输入语言。Parser 与 DTCG Format/Color 校验分离。Core 保留颜色语义，序列化或转换仍是 Backend policy。准确支持范围参见 [DTCG 支持矩阵](DTCG-SUPPORT.zh-CN.md)。

### Importer / Migrator 边界

可选 Importer 位于编译器外部：

```text
Foreign 或 Legacy Syntax
  → Importer / Migrator
  → DTCG 2025.10 Source
  → tokenc Compiler
```

Importer 负责理解外部语法、转换值、输出有效 DTCG 并报告迁移诊断。Compiler 负责解析和校验 DTCG、构建强类型语义节点与 Graph Edge、执行 Resolve/Check，再生成平台产物。Importer 不能通过直接构造 `TokenNode` 绕过 DTCG Parser。本版本的 Compiler Core 不包含 Migrator。

## Parser 与 Source Provenance

Parser 接收文件内容和 source identity，而不是由 Parser 自己打开文件。项目使用 `jsonc-parser` 获得能够保留 offset 的 JSON AST，再通过轻量行索引将 offset 转换为：

```text
file
line
column
length
source excerpt
```

每个 Token 和 Reference 都保留 `SourceLocation`。因此，即使原始 JSON 已经转换为语义模型，Diagnostic 仍然可以准确指向源文件。

无效 JSON 会生成结构化诊断和一个空 document，而不是让 watch process 崩溃。修复文件后，同一增量 Session 可以自动恢复。

Syntax Parser 记录显式与继承类型候选，而不要求当场确定所有 Token 的最终类型。Linker 解析前向、后向、
链式与跨文档 Alias。最终优先级为 Token 显式 `$type`、引用目标类型、Group 继承类型。只有完成链接的
强类型 `TokenNode` 才会进入 Graph、Checker、Resolver 与 Backend。

Group 会把最近的 `$type` 传递给子节点。拥有 `$value` 或构成 `$ref` 引用对象的属性会成为 Token；
同时包含 Token 定义与子节点的非法结构会被诊断。保留字 `$root` Token 会显式保留在 canonical path
中。Group `$extends` 使用继承边与有效成员关系表达，而不是全局对象 Deep Merge。

## Typed AST

核心模型是显式的数据结构：

```text
TokenNode
  id: TokenId
  type: TokenType
  value: TokenLiteralExpression | TokenReference | JsonPointerReferenceExpression
  baseCandidate: DependencyCandidateId
  overrides: ContextOverride[]
  dependencyOccurrences: DependencyOccurrence[]
  inheritance?: TokenInheritance
  source: SourceLocation
```

全部标准 Token 类型都有具体的内部模型与 Validator。`cubicBezier`、`strokeStyle`、`border`、
`transition`、`shadow`、`gradient` 与 `typography` 会校验必填字段、封闭结构和适用的数值范围。
`TokenExpression<T>`、`TokenNode<T>`、`ResolvedToken<T>` 与 `CompiledToken<T>` 让解析后的类型贯穿
整个流水线。

RFC 6901 引擎是独立于 IO 的 DTCG 模块。指向完整 Token 或完整 `$value` 的 Pointer 会归一化为
Token Reference；指向嵌套分量的 Pointer 保留表达式和解析值，同时产生带 field path 与 source range 的
`DependencyOccurrence`。Backend 不解析原始 Pointer；平台无法保留分量引用时使用解析后的值。

## Token ID

`TokenId` 是 branded canonical string。下面的函数定义了它的 API 边界：

```ts
parseTokenId();
formatTokenId();
parentTokenId();
tokenIdFromSegments();
tokenIdSegments();
```

Graph 内部始终使用 canonical ID 作为 `Map` key，而不是反复使用 `string[]` 遍历路径。

## Dependency Graph

`TokenGraph` 维护三类事实与索引：

```text
Map<TokenId, TokenNode>       tokens
DependencyEdge[]              conditional edges
Map<TokenId, DependencyEdge[]> forward / reverse indexes
```

Frontend 在去重前保留每一次 Alias、JSON Pointer、Composite Field 与 Inheritance occurrence。每条
`DependencyEdge` 携带 owner、target、kind、field path、source range，以及由 candidate 胜出区域计算的
精确 `ContextPredicate`。raw selector 会先减去所有更高优先级 candidate 的区域，因此不会被误当作
effective condition；重复引用仍是独立 edge。

Predicate 是有限 Context domain 上规范化且互不重叠的 DNF，对交、并、补、差集与可满足性判断闭合。
循环成立当且仅当闭合路径全部 edge condition 的交集可满足。Checker 先在无条件结构上定位强连通区域，
再做符号 Predicate 相交，不再枚举 Context 笛卡尔积。循环诊断返回具体 edge path、witness Context，并将
每个 related location 指向引用 occurrence。

Token 和正反向 edge 查询由索引支持。使用稳定 lexical ordering 的 Kahn 排序消费指定 Context 下的有效
edge；affected 与 dependency closure 在传播过程中相交 Predicate，只保留真正受影响的 Context 区域。

每次编译都会构造一张新的私有 Graph；发布时再克隆并冻结独立的 Graph-backed Snapshot。因此 Session
推进后也无法改变已保留的 snapshot。

`explain` 和 `usages` 都直接查询同一张 Graph，不会搜索源文件字符串。

循环引用会输出闭合路径、使其成立的 Context 和相关源码位置。未知 Reference 仍然会作为 Graph Edge 保留，让 Checker 可以根据所有 canonical ID 提供相似名称建议。

继承 Token 会指向 Base Token，分量 Pointer 会指向拥有该分量的 Token。因此 Cycle Detection、
`explain`、`usages`、Impact Analysis 与 Incremental Invalidation 对所有引用形式使用同一套 Graph 语义。

## Query API 与 Explain Trace v1

`snapshot.query` 是 Token 查询、定义跳转、补全、解析、依赖、用法、影响、Graph 投影与解释的只读
消费边界。Dependency 与 reverse usage 查询可以接收具体 Context 或 `ContextPredicate`；两者都不提供
时会保留并返回原始条件区域。结果包含 occurrence 源码位置，使用稳定字典序，并且不暴露内部 Map 或
Set。

`query.context(overrides)` 会合并配置默认值、当前 DTCG Resolver 选择和调用方 override，并返回冻结的
有效 Context。消费者不需要读取 IR 或 Resolver 状态来构造 Context。

Impact 结果区分 changed、directly affected 与 indirectly affected Token，并保留每项的精确 Predicate。
传播过程持续对 Graph Edge 的 Predicate 求交，因此只存在于互斥 Context 的两条边不会产生虚假的传递
影响。

`ExplainTraceV1` 包含 schema version、规范化 Context、每一步选中的 candidate 与 base/override 原因，
以及存在时的 precedence/origin、带源码位置的 dependency step、Resolver step 和最终值。CLI 的
`explain`、`usages` 与 `graph` 命令只消费此 facade，并提供确定性的 `--json` 输出。

### 为什么将 Token 建模为 Graph？

Alias 不是字符串插值，而是语义依赖。一旦 Reference 被表示为 Edge，以下能力就变成同一种 Graph Operation：

- Cycle Detection
- Evaluation Order
- Reverse Usage Lookup
- Impact Analysis
- Incremental Invalidation

这些能力不再需要分别实现。

## Context Resolver

Context 是不可变的 key/value 求值输入，例如：

```text
theme=dark
brand=enterprise
density=compact
```

基础值和稀疏 Extension Override 都保留在同一个 Token Node 上。选择顺序为显式 precedence、匹配维度数量、配置中的维度顺序，不再依赖 JSON 声明顺序。

解析过程是惰性的，并以 `(TokenId, Context)` 为 key 缓存。Compiler 只记录 default context 和源码实际声明的 override 组合，不会物化 theme × brand × density 的完整 Token Dictionary。

`$extensions["org.token-compiler.contexts"]` 是非标准 tokenc 扩展。独立 Interpreter 将其转换为由
同一 `TokenResolver` 消费的强类型 Context Override；标准 DTCG Token Parser 不依赖该扩展。DTCG
Resolver 则在构图前组合 Source，因此两种机制具有不同语义。

## DTCG Resolver Module

`parseResolverDocument(content, source)` 是不执行 IO 的 DTCG 2025.10 Resolver Frontend。它生成带
源码位置的 `TokenSet`、`ResolverModifier`、`ResolutionSource` 与有序 Resolution Item。Resolver
引用对象复用统一 RFC 6901 Parser。本地 sibling 字段在引用目标上形成浅层语义视图：Object/Array
字段整体替换，不修改目标，并保留两处来源。IO 层加载相对路径完整文件；语义解析负责校验运行时
Input、展开同文档 Set 引用、选择 Modifier Context，并严格按照 `resolutionOrder` 产生 Source Stream。

只有 Resolver Resolution 内部使用标准规定的“后 Source 覆盖前 Source”规则；普通多文件编译仍会诊断重复 canonical ID。Alias 会在 Source Stream 组合完成后进入 Graph 检查，因此 Resolver 不是全局 deep merge hook。

### 为什么不用 Global Deep Merge？

Deep merge 会带来几个问题：

- 丢失 source provenance
- 让优先级变成 object order 的副作用
- 复制大量未变化的值
- 隐藏具体由哪个 modifier 改变了 Token

稀疏 override 保持了 Token identity、type、source 和 graph edge 的稳定性，同时让 Context 成为显式求值输入。

## Type Checker 与 Diagnostics

Checker 验证：

- Reference target 是否存在
- Source Token 和 Target Token 的类型是否一致
- Context dimension 和 value 是否合法
- Canonical Token ID 是否重复
- Graph 是否包含循环依赖

所有阶段统一输出 `DiagnosticV1`：每个值都包含 `schemaVersion: "1"`、注册表管理的 code、结构化
parameters、主位置与相关位置、文档 URL、可选的校验后文本编辑，以及 SHA-256 base64url
fingerprint。Fingerprint 只使用规范化文档标识、语义锚点和注册表声明的 identity parameters；message、
severity、显示 range、fix 与 timing 不参与问题身份。没有语义锚点的 parse error 使用解析器错误种类与
原始 offset。

Core 不负责终端颜色和打印；CLI 为人类渲染 code frame，并用固定 envelope
`{ "schemaVersion": "1", "diagnostics": [...] }` 输出 machine-readable JSON。旧的 suggestion string
已经删除：不可机械执行的建议进入文档或 related information，可机械执行的建议使用按位置排序、互不
重叠且带源码内容 digest 的 edit。

Graph Cycle 会在递归求值前独立校验，因此用户看到的是完整依赖路径，而不是运行时堆栈错误。

## Compiler IR

`Compilation` 是 Backend 唯一可以消费的输入。Token 顺序使用 default Context 的有效依赖投影计算，
因此即使保守并集 Graph 含有互斥的条件环，TypeScript 等符号型目标仍会先声明当前实际依赖。它还公开
强类型 `tokensOfType()` 视图与结构化 `explainToken()` trace，并继续提供：

- 按拓扑顺序排列的 `CompiledToken`
- 已验证的 `TokenGraph`
- Context Definition 和实际 Context
- Context-aware `resolveToken()`
- Structured Diagnostics

Backend 不允许自己重新 parse、validate、merge 或搜索源文件。

这个边界将 source-language concern 保留在 Frontend，把 platform policy 保留在 Backend。

## Reference Resolution 为什么属于 Backend Policy？

如果 Compiler 全局解析所有 Alias，就会丢失有价值的语义：

- CSS 希望输出 `var(--dependency)`
- TypeScript 可能希望输出 symbol reference
- 静态目标平台可能需要最终 literal

Backend 可以选择三种概念策略：

- `preserve`：使用目标平台的引用语法保留依赖。
- `symbol`：生成编程语言符号引用。
- `resolve`：生成求值后的最终值。

Resolver 始终能够提供最终值，但 IR 同时保留被选中的表达式，让 Backend 决定是否保留 Graph Edge。

## 为什么平台输出叫 Backend？

CSS、Tailwind 和 TypeScript 是编译目标，不是格式化 callback。Backend 声明只读
`BackendCapabilities`，并且只能接收不可变的 `CompilationIR`；Graph 与 Resolver internal 不会暴露。

```ts
interface TokenBackend {
  id: string;
  capabilities: BackendCapabilities;
  prepare(ir: CompilationIR): Promise<BackendPlan> | BackendPlan;
  emit(plan: BackendPlan): Promise<readonly OutputFile[]> | readonly OutputFile[];
}
```

`prepare(ir)` 返回包含全部 Diagnostic、已分配 symbol 和有序 artifact identity/path 的
`BackendPlan`。Core 收集全部 plan 后执行一次全局预检；任何 capability、symbol、value 或 path error
都会阻止所有 Backend emit。`snapshot.prepare(backends)` 会完整执行 prepare/preflight，因此
`tokenc check` 可以验证目标而不生成文件。

`emit(plan)` 不再接触 Compilation，并且必须精确返回 plan 声明的 artifact identity 与 path。缺少、
新增、改名或重排 artifact 会抛出 `BackendContractError`，整组内存输出被丢弃。Artifact path 必须是
规范化的相对路径；全局碰撞 key 使用 Unicode NFC 与 case folding，确保产物可跨文件系统安全移动。

所有平台 symbol 都由共享 `SymbolAllocator` 分配。每个 namespace 声明 Unicode normalization、大小写
策略、保留字和合法 pattern；冲突带源码位置，且只能通过显式 rename map 解决，不会自动追加不稳定数字。

公共 API 不暴露 transform、filter、action、formatGroup 等复杂 hook 分类。这能避免平台规则泄漏到 Parser 或 Resolver。

## Backends

### CSS

生成 canonical CSS Custom Properties。

- `preserve` 将 Reference 映射为 `var()`。
- `resolve` 内联最终求值结果。
- Context selector block 与默认环境比较，只输出变化的声明。
- 自动 selector 对应一个完整 canonical Context，key 中不安全的 UTF-16 code unit 使用 `%XXXX`
  编码。若稀疏 predicate 省略了其他可变维度、且这些组合未全部声明，则返回
  `BACKEND_CONTEXT_COVERAGE`，既不物化笛卡尔积，也不依赖 CSS cascade 顺序。自定义 base selector
  与自动非默认 Context 同时存在时也会失败，因为 Backend 无法证明 selector specificity；非空
  `selectors` map 则明确指定并校验需要输出的 Context 集合。不同 Context 不能复用同一个 selector；
  自定义 base 与显式变体并用时，base 必须写入默认 Context 对应的 map entry。
- number 保留源精度；只有所有 sRGB 分量都能由 8 bit 精确表示时才使用 hex。border、transition、
  shadow 与 cubic Bézier 输出合法 CSS 值；typography 无损拆分为多个后缀变量，其中控制字符使用 CSS
  string escape。
- CSS 禁止的负数字段、CSS 无法无损表示的 font-family code unit，以及 custom dash-array stroke style
  会产生 `BACKEND_UNSUPPORTED_VALUE`。DTCG gradient 只有 stop、没有 CSS gradient function 或
  geometry，因此在显式平台 transform 提供该策略前同样会被拒绝。
- emit 前校验 custom-property 语法，并检测归一化名称及 composite 后缀名称碰撞。

### TypeScript

Flat mode 生成拓扑排序后的 binding，并支持 symbol reference。Object mode 生成嵌套的 `as const` 对象；必要时 symbol mode 会创建内部有序 binding。

### Tailwind v4

生成三部分内容：

- `--token-*` runtime property
- 稀疏 Context override
- Tailwind `@theme` binding

Tailwind variable 指向运行时层，因此普通 CSS 和 utility 可以共享同一份值，theme switching 也不需要复制完整语义 Token Store。
Tailwind 与 CSS 使用相同的编码后完整 Context 输出契约和覆盖检查，而不依赖不同维度 block 的源码
顺序。它复用 CSS value serializer，包括数值精度与 unsupported-value 策略；Tailwind theme 名会先
canonicalize 并检查碰撞，顶层 namespace token 使用 `default` 名称，避免生成空后缀。

## Compilation Snapshot

`compile()` 与 `compileDocuments()` 发布判别联合 `CompilationSnapshot`。每个 snapshot 都固定保存
Document 内容、稳定语义 Diagnostic、统计、source/configuration digest 和单调递增的 builder revision。
只有 valid snapshot 暴露不可变 `CompilationIR`、`prepare()` 与 `emit()`；invalid snapshot 保留安全的
Graph 查询，而 `resolve()` 与 `explain()` 返回显式 unavailable 结果。Backend 操作 Diagnostic 不会混入
snapshot 的语义 Diagnostic。

每次发布都拥有克隆、冻结的 Graph 视图。Query 结果、解析值、trace、IR collection 与输出记录都不能被
调用方用来改变后续观察结果。Backend planning 只针对一份固定 IR，并在任何 Backend emit 前完成全局
路径预检。

## Compiler Session 与 differential correctness

`CompilerSession` 是长生命周期编译边界。每次 `apply()` 都进入同一条 FIFO 队列，并以原子 transaction
新增、更新、删除 Document 或替换配置。请求通过可注入 `DocumentLoader` 解析；同一 transaction 中的
重复请求只加载一次。语义失败会提交请求状态、发布 invalid `currentSnapshot`，同时保留上一份
`lastSuccessfulSnapshot`；Loader 失败与 `AbortSignal` 取消则不提交、不发布。`close()` 幂等，并拒绝后续
transaction。

M1-08a 先以每个 transaction 执行无缓存全量重建的方式，为阶段 cache 建立正确性基线，而不是继承已删除
的可变 `IncrementalCompiler` 与 Graph patch 模型。可复用 differential oracle 对 Session 执行确定性的
transaction corpus，并把每次发布与一次全新编译比较。规范化范围包括语义 Diagnostic、条件 Graph、
有限 Context 全枚举下的 resolved value 与 explain trace，以及 Backend 输出字节；revision、timing 与未来
cache counter 不参与比较。

M1-08b 在该边界上加入 cache。Parse entry 以 Document identity、content、origin 和 parser version 为
key；Linker 把 Document 划分为保守的跨文档引用连通分量，并复用 ordered parse key 未变化的分量；出现
group inheritance 时回退为一个安全的全局分量。只有 linked component key 与 `ContextDefinition` 都相同
时才复用 conditional Graph。Resolver entry 以 Token ID 与 canonical Context 为 key；只有 candidate
变化和反向条件边在该 Context 中不可达时才保留。Cache state 与 transaction snapshot 一起提交。当前
Backend contract 无法为任意 callback 提供完整稳定 key，因此 Backend plan 保持不缓存。

## 测量边界

每个 `CompilationSnapshot` 都通过 `stats` 提供只读工作量数据。`timings` 以毫秒报告 `parse`、
`link`、`graph`、`check`、`resolve`、`emit` 六个阶段以及端到端 `total`。`session.metrics` 报告最近一次
已提交 transaction 各阶段的 hit、miss、reuse、recomputation 与 invalidation 数据。这些指标不得选择
编译语义，且每项 cache 都必须通过 differential oracle。

`contextCycles` 报告候选强连通区域数、相关维度总数、估算与实际枚举投影数、静态循环提前退出、投影
上限命中和估算饱和。它们只描述已经执行的工作；timing 与 counter 都不会选择编译行为或抑制
Diagnostic。`benchmarks/` 中的版本化工具在同一边界上分别采样耗时与峰值内存。

## Impact API

`TokenGraph.analyzeImpact(changedIds)` 将影响分为：

```text
changed
directlyAffected
indirectlyAffected
```

即使 v0.1 尚未提供 `tokenc diff`，这个 API 也已经属于 Core，未来 CI 和 Pull Request Review 可以复用同一语义图。

## Computed Token 扩展点

当前表达式联合类型包含：

```text
Literal Node
Reference Node
Resolved JSON Pointer Component Node
```

未来可以加入新的 `ComputedTokenNode`。Computed Node 会在 Graph Construction 前提供 dependencies，
Function Parsing 和 Evaluation 作为新的 Compiler Stage 实现，而 Backend 继续消费相同的 Resolved IR。

v0.1 不会为了提前支持这个能力而创造非标准 Function Syntax。

## Package 边界

```text
@tokenc/core
  ↑
  ├─ @tokenc/backend-css
  │    ↑
  │    └─ @tokenc/backend-tailwind
  ├─ @tokenc/backend-typescript
  ├─ @tokenc/cli → backends
  └─ @tokenc/language-server → @tokenc/cli 配置宿主
```

Core 不会导入 CLI 或 Backend。Backend 只依赖公开的 Core IR。CLI 负责配置加载、文件写入、终端输出、进程信号和 watcher 生命周期。
Tailwind Backend 额外复用 CSS Backend 的公开 value serializer，但仍只读取 Core IR，不修改 CSS
Backend 或 Compilation 状态。

所有 CLI 编译命令都会创建 `CompilerSession` 并消费其 Snapshot。dev 在 Token、配置与 Resolver reload
之间保持同一个 Session；rebuild coordinator 会取消已被新事件取代的任务、阻止陈旧输出，并在无效输入
或无效配置之后继续等待恢复。Architecture test 会拒绝 CLI 与内置 Backend 对 Core internal module 的
deep import 或相对路径 import。
Language Server 只负责 protocol、trust、URI、overlay 与 workspace scheduling；配置加载复用 CLI
的可信宿主，语义状态只通过 Core 的公开 Session/Snapshot API 获取。

## 关键原则

```text
Token ≠ JSON property
Token = typed node

Reference = graph edge
Theme = context
Resolution = compiler operation
Platform = backend
Output = compiler artifact
```

# M3 执行计划：IDE-first 开发体验

[English](M3-PLAN.md)

> 状态：规划已敲定，可以开始执行。M2 已关闭，五个同步版本的 `0.5.0` package 已通过 `next`
> dist-tag 发布。更新时间：2026-09-01。
>
> 目标版本线：`0.6.0`。M3 新增公开 package `@tokenc/language-server`。薄 VS Code client 以可安装
> VSIX 完成验证；发布到 Marketplace 不属于 M3 退出门槛。

## 1. 阶段结果

M3 将编译器已有的唯一事实源带入编辑循环。用户编辑 DTCG 项目时，必须获得与 CLI 相同的诊断和 Graph
答案；同时，未保存 buffer、无效 JSON、取消请求与 multi-root workspace 都必须保持安全、确定。

第一版回答五个问题：

1. 光标下是什么语义对象？
2. 它在哪里定义，在当前 Context 下被哪些位置使用？
3. 它的类型、源码表达式、resolved value 与 provenance 是什么？
4. 哪些补全和编辑不会制造 canonical ID 或 Backend collision？
5. 编辑器能否丢弃过期工作，并从不完整输入自动恢复且不显示陈旧结果？

实现必须是 `CompilerSession`、不可变 snapshot、Query、diagnostic registry 与 Backend preparation
之上的协议适配层，而不是第二套 Parser、Graph、Resolver 或 Checker。

## 2. M3 固定决策

1. **唯一语义权威。** 每个 LSP 答案都来自当前 `CompilationSnapshot` 及其公共 Query API。协议层不得解析
   DTCG 语义或自行遍历依赖。
2. **每个 workspace folder 一个 Session。** Multi-root workspace 彼此隔离；每个 folder 独占 config、
   document overlay、active Context、revision counter、scheduler 与 diagnostics。
3. **未保存文本优先。** 打开的编辑器 buffer 覆盖文件系统文档。`didChange` 把完整当前 buffer 作为一个
   原子 Session transaction 提交；`didClose` 后恢复由磁盘内容提供权威数据。
4. **显式采用 UTF-16。** LSP 边界按 LSP 3.17 使用 UTF-16 position；Core 保持与 LSP type 无关的 offset。
   CRLF、Unicode astral character、escaped string 与 file URI normalization 必须有独立 fixture。
5. **每项结果绑定 revision。** 请求捕获 workspace revision 与 document version。被取消或取代的工作即使
   稍后完成，也必须在发布前丢弃结果。
6. **无效输入是正常状态。** 发布当前无效源码的 diagnostics；能够由 partial source index 安全回答的功能
   可以继续工作，resolved value 与 Backend fact 返回 unavailable，不得偷偷读取上一个成功 snapshot。
7. **取消采用 cooperative、fail-closed 语义。** Server 中止过期任务，Core 在有界 stage/traversal 边界
   观察 `AbortSignal`；被中止的 transaction 不提交 Session state，也不发布 diagnostics。
8. **编辑器操作只生成计划，不直接写入。** Rename 与 code action 返回确定、带 digest guard 的 edit；只有
   client 可以应用 `WorkspaceEdit`，server 不直接写项目文件。
9. **Rename 属于语义操作。** Core 为 alias、JSON Pointer、inheritance 与 component occurrence 规划
   declaration/reference edit，并在提供编辑前检查 canonical ID 与全部已配置 Backend symbol table。
10. **Context 属于 workspace state。** Hover、references、diagnostics 与 rename preview 使用同一个显式
    effective Context；Resolver input 与普通 Context override 继续保持不同语义。
11. **Workspace Trust 控制可执行 config。** VS Code client 只在 trusted workspace 启动 server；其他 client
    必须显式允许 config 执行。未受信任的 server session 不 import `tokenc.config.*`。
12. **优先采用标准 LSP。** M3 使用标准 initialize、sync、diagnostics、completion、definition、references、
    hover、symbols、rename 与 code-action method。Rich graph/diff view 和自定义协议延后。
13. **Extension 必须保持薄。** 它只启动 server、转发配置与 Context 选择并提供状态/命令，不包含编译语义。
14. **允许直接修改。** M3 不需要兼容 facade。公共 TypeScript 行为变化仍需 Changeset 与 contract 更新；
    已发布 JSON Schema 必须通过版本演进。

## 3. 现有权威边界

| 现有边界                          | M3 权威职责                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `packages/core/src/session.ts`    | 原子文档/配置更新、缓存所有权、取消、当前与最近有效 snapshot                             |
| `packages/core/src/snapshot.ts`   | 不可变 revision、documents、diagnostics、Query、IR 与 invalid-state 边界                 |
| `packages/core/src/query.ts`      | Token/source 查询、definition、usages、completion candidate、Context、resolve 与 explain |
| `packages/core/src/frontend.ts`   | JSON syntax tree、源码 range、reference occurrence 与无效输入中的 partial fact           |
| `packages/core/src/diagnostic.ts` | Code、severity、稳定 fingerprint、related location 与 digest-guarded fix                 |
| `packages/core/src/backend.ts`    | Rename preview 复用的 symbol allocation 与 collision diagnostics                         |
| `packages/cli/src/index.ts`       | 当前 config discovery/loading 行为与 diagnostics parity 的 CLI 一侧                      |
| `benchmarks/` 与 `contracts/`     | 可复现语义工作量证据与公共 declaration/schema 锁                                         |

M3 可以扩展这些公共边界，但不得创建 editor-only 的 Token identity、reference parser、Context selection、
diagnostic fingerprint 或 Backend naming 实现。

## 4. 契约目标

Core 新增与传输协议无关的 editor query 层。M3-00 可以细化命名，但以下不变量已经固定：

```ts
type EditorSymbolRole = "declaration" | "alias" | "json-pointer" | "inheritance";

interface EditorSymbolV1 {
  readonly schemaVersion: "1";
  readonly role: EditorSymbolRole;
  readonly owner: TokenId;
  readonly target: TokenId;
  readonly source: SourceLocation;
  readonly fieldPath: readonly (string | number)[];
  readonly condition?: ContextPredicate;
}

interface RenamePlanV1 {
  readonly schemaVersion: "1";
  readonly status: "ready" | "rejected" | "unavailable";
  readonly token: TokenId;
  readonly replacement: TokenId;
  readonly edits: readonly TextEdit[];
  readonly diagnostics: readonly DiagnosticV1[];
  readonly backendPreviews: readonly BackendRenamePreviewV1[];
}
```

- 能从无效 JSON 安全推导的 source-index query 继续可用。
- 所有返回集合都不可变且按确定顺序排列。
- Core type 不包含 `vscode-*`、URI、JSON-RPC 或 LSP protocol object。
- Definition/reference 保留 occurrence role 与精确 source span。
- Rename plan 是全有或全无：无效 ID、陈旧 digest、歧义 occurrence、重复 ID 或 Backend collision 都会拒绝
  整个计划，不返回可应用 edit。
- 只有使用生成 snapshot 时完全相同的 document content/version 把 Core offset 映射完成后，才能生成
  workspace edit。

公开 `@tokenc/language-server` package 提供 Node.js server executable 与可测试 library entry。第一版协议
能力为：

```text
textDocumentSync: incremental transport, full-buffer Session updates
publishDiagnostics
completionProvider
definitionProvider
referencesProvider
hoverProvider
documentSymbolProvider
workspaceSymbolProvider
renameProvider + prepareProvider
codeActionProvider
```

## 5. Workspace 与协议模型

Workspace discovery 从每个 LSP workspace folder 开始。显式 initialization/configuration path 优先；否则
server 只在该 folder 中寻找受支持的 `tokenc.config.*`。Source glob、Resolver document 与 Backend config
均来自这份受信任 config。

每个 workspace coordinator 持有：

```text
trusted config snapshot
filesystem documents + open-buffer overlay
CompilerSession
active Context / Resolver input
latest requested and published revisions
AbortController for superseded work
URI ↔ canonical document identity mapping
```

生命周期规则：

- `initialize` 只声明已经实现的 capability；`shutdown` 关闭全部 Session。
- `didOpen`、`didChange`、watched-file event、config change 与 Context change 转换为串行原子 transaction。
  只有在不承诺可观察中间版本时，才允许合并 burst。
- 删除文档时清空其 diagnostics；diagnostics 只针对最新接受的 document version 发布。
- 初始编译完成前收到的请求返回空或 unavailable，不抛出异常。
- 位于所有 workspace 之外的文件默认忽略，除非 client 将其显式打开为独立 trusted project。
- 协议错误通过 connection 记录，不终止 server process。

## 6. 功能语义

### Diagnostics 与恢复

- LSP severity、code、source、message、related information 和 documentation URL 直接映射 Diagnostic v1。
- Diagnostic identity/fingerprint 保留在 `data` 中，供去重与 code-action lookup 使用。
- 无效 edit 发布当前 parse/semantic diagnostics；修复后无需重启 server 即自动发布有效替换结果。
- CLI/LSP parity 在 transport formatting 前比较 normalized Diagnostic v1 fact。

### Completion、导航与 Hover

- Completion 只在已识别的 alias/reference 位置提供；candidate 来自
  `snapshot.query.completions()` 与 Core source index，排序和过滤必须确定。
- Definition/reference 使用准确的 semantic target 与 occurrence list，包含 component pointer 与
  inheritance；Context filter 不隐藏 declaration 本身。
- Document/workspace symbol 从 canonical Token hierarchy 与 source ownership 推导。
- Hover 展示 canonical ID、type、source expression、resolved value、effective Context、provenance 与相关
  unresolved diagnostics。当前 snapshot 无效时 resolved preview 为 unavailable，不显示陈旧值。

### Rename 与 Code Action

- `prepareRename` 只在能无歧义对应 Token ID 的语义 declaration/reference 上成功。
- Rename 校验 replacement ID，构造全部 declaration/reference edit，检查 overlap 与 document digest，
  virtual recompile 完整项目，并 preflight 已配置 Backend。
- Canonical collision、Backend symbol collision、无效 JSON Pointer rewrite 或 coverage 不完整都会在返回
  `WorkspaceEdit` 前拒绝整个操作。
- Quick fix 复用已校验的 Diagnostic v1 edit；返回 action 前立即复核 document version 与 digest。
- Action 不 shell out、不 emit Backend 文件、不修改 config，也不直接写磁盘。

## 7. 范围

M3 包含：

- 带 stdio executable 和 library entry 的公开 `@tokenc/language-server`。
- 私有的薄 VS Code extension workspace 与可复现 VSIX artifact。
- Trusted workspace/config discovery、multi-root isolation、open-buffer overlay 与 file watching。
- Push diagnostics、alias completion、definition、references、hover、document/workspace symbols、
  collision-safe rename 与 structured code action。
- 显式 active Context/Resolver input 配置，以及 hover 中的 resolved-value preview。
- Core editor source-index 与 rename-plan contract；承诺机器序列化时提供公共 declaration 与 schema。
- Protocol conformance、CLI/LSP differential、process-level end-to-end、语义工作量及 latency/memory benchmark。

M3 不包含：

- 独立 GUI、graph/diff Webview、semantic token、formatter、inlay hint 或 color picker UI。
- Marketplace 发布、telemetry、账号服务或远程项目索引。
- 持久 daemon/cache、worker farm、网络 transport 或 browser-hosted language server。
- 通用 lint/importer/plugin SDK、新生产 Backend 或非 DTCG source semantics。
- 自动编辑未被 accepted snapshot 表示的文件。
- 在 untrusted workspace 中执行 config。

## 8. 交付顺序

### Gate 0：先冻结协议语义与证据

#### M3-00 — IDE RFC、协议语料与基线（P0）

状态：已完成。证据见 [RFC 0005](rfcs/0005-ide-language-server.zh-CN.md) 与
[M3-00 编辑循环基线](M3-00-BASELINE.zh-CN.md)。Gate 0 已接受并放行 M3-01。

交付：

- 编写一份 RFC，覆盖 source-index role、URI/offset mapping、Workspace Trust、overlay、revision ordering、
  cancellation、invalid-state behavior、Context selection、rename atomicity 和被否决方案。
- 添加 initialize/open/change/close、diagnostics、completion、navigation、hover、symbols、rename、code action、
  cancellation、multi-root 与 shutdown 的受版本控制 protocol transcript。
- 添加 Unicode/CRLF 与 partial-invalid JSON fixture，并写明精确预期 range。
- 记录 cold startup、warm one-file update、invalid/recovery、cancellation 与 high-fan-out edit 基线，包括
  semantic work、p50/p95 wall time 和 peak memory。

验收：

- 路线图每项 capability 都映射到 protocol transcript 与 Core authority。
- Trust 与 stale-result 行为显式且 fail closed。
- 基线可复现，不包含未经证据支持的性能结论。
- Gate 0 通过前不创建公开 LSP package，也不向 Core 引入 editor-specific type。

### Wave 1：Core 编辑器契约

#### M3-01 — Source index 与 editor Query 垂直切片（P0）

状态：已完成。Snapshot 现持有不可变且与 transport 无关的 source index；Query 已公开精确 position、
document-symbol 与 Context-filtered occurrence operation。公开 `EditorSymbolV1` schema 以及
Unicode/CRLF/invalid-input 证据均已锁定，并已放行 M3-02。

交付：

- 从现有 Frontend 保留 declaration/reference span 与 role，形成每个 snapshot 独占的不可变 source index。
- 在公共 Query facade 增加 position lookup、document symbol、精确 occurrence query 与 contextual completion
  fact。
- 在无效输入中保留安全的 partial fact，但不虚构 semantic target。
- 如果 editor query 承诺公共 v1 payload，则增加确定性 serialization fixture。

验收：

- Alias、JSON Pointer、component field 与 inheritance occurrence 对应同一套 Graph fact。
- Unicode、escape、CRLF、nested group、`$root` 与 duplicate ID 的 range 精确。
- Query result 不可变、稳定且不包含 LSP type。
- 现有 CLI/Query 行为与公共 contract 继续通过。

#### M3-02 — Collision-safe rename planning（P0）

状态：已完成。Core 只有在 virtual recompile、semantic-equivalence check 与可选 Backend preflight
全部通过后才返回确定且带 digest guard 的 rename plan。Canonical、Unicode、case-folded、reserved、
invalid、ambiguous 与 Backend collision 路径全部 fail closed。下一步为 M3-03。

交付：

- 在单个不可变 snapshot 上增加纯 Core rename planner，输入 proposed canonical ID。
- 使用 digest-guarded edit 重写 declaration 与每种受支持 reference spelling。
- Virtual recompile 完整 edit set，并 preflight 已配置 Backend symbol/artifact。
- 返回确定的 ready/rejected/unavailable plan 与结构化 diagnostics。

验收：

- 成功计划除目标 ID 外保持 resolved value 与 dependency topology 不变。
- Canonical、case-folded、Unicode-normalized、reserved-word 与 Backend collision 在 edit 暴露前被拒绝。
- 歧义或不支持的 occurrence fail closed，不可能产生 partial rename。
- 在内存中应用 edit 后的编译结果与 planner preview 完全一致。

### Wave 2：Language Server 垂直切片

#### M3-03 — Server package 与 workspace lifecycle（P0）

交付：

- 创建 `@tokenc/language-server`，使用固定版本的 LSP dependency，提供 stdio binary 与 library factory。
- 实现 initialize/shutdown/exit、workspace-folder add/remove、trusted config discovery、source loading、
  open-buffer overlay 与 watched-file routing。
- 每个 workspace folder 只维护一个 `CompilerSession` 与 latest-work scheduler。

验收：

- Process-level client 可以 initialize、打开 fixture project、观察一个 snapshot 并 shutdown，且无 handle
  泄漏。
- 两个拥有相同相对路径的 workspace folder 不共享 document、Context 或 diagnostics。
- Untrusted workspace 不 import 可执行 config。
- Package 内不包含 Parser、Graph、Resolver 或 Backend naming 实现。

#### M3-04 — Diagnostics、恢复与取消（P0）

交付：

- 将 Diagnostic v1 映射为带精确 range、related information、URL 与 fingerprint data 的 LSP diagnostic。
- 实现 incremental text sync、version tracking、latest-wins publication、diagnostic clearing 与自动
  invalid-to-valid recovery。
- 仅在 M3-00 基线证明必要的位置增加 cooperative Core cancellation checkpoint。

验收：

- 相同 source/config/Context 的 CLI 与 LSP diagnostic fact 完全一致。
- 无效 JSON 不导致崩溃，也不会用陈旧有效 diagnostics 覆盖当前错误。
- Cancelled/superseded revision 不发布结果且不提交 Session state。
- Open/change/close 与 filesystem race 最终收敛到最新权威内容。

#### M3-05 — Definition、References 与 Symbols（P0）

交付：

- 从 Core source index 与 Query API 实现 definition、references、document symbol 与 workspace symbol。
- 跨文件和 Context region 保留准确 occurrence role 与确定排序。

验收：

- 每种受支持 reference form 都能导航到 canonical declaration。
- References 与 Core usages/source-index fact 完全一致。
- 文件删除/重命名后结果被清除；无效文档只返回当前 snapshot 能证明的 fact。

#### M3-06 — Alias Completion 与 Context-aware Hover（P0）

交付：

- 只在已识别 reference position 实现 completion，并保持稳定 sort/filter 行为。
- 实现 type、expression、resolved value、provenance、active Context 与相关 diagnostics 的 hover。
- 支持普通 Context override 和 Resolver input 的配置变更，但不混淆两者语义。

验收：

- Completion 不建议无效或超出作用域的 canonical ID。
- Hover value 与同一 snapshot/Context 的 `query.resolve()`/`query.explain()` 相同。
- Context 变更只失效 Session metrics 证明必要的工作，且不在 workspace 之间泄漏值。

#### M3-07 — Rename 与 Code-action Transport（P0）

交付：

- 将 Core rename plan 映射到 `prepareRename` 与 versioned multi-document `WorkspaceEdit`。
- 在安全时把已校验 Diagnostic fix 暴露为 preferred quick fix。
- 返回 edit 前重新校验 snapshot revision、document version 与 digest。

验收：

- 任何 client edit 前都能得到 canonical 与 Backend collision。
- Stale、overlap 或 digest mismatch edit 不会暴露。
- 通过测试 client 应用 accepted rename 后得到 planner 预测的 snapshot。
- Code action 不暴露 diagnostic registry 禁止的 edit。

### Wave 3：编辑器交付与发布证明

#### M3-08 — 薄 VS Code Extension 与 VSIX Smoke（P1）

交付：

- 增加私有 VS Code extension，负责 bundle/start server、遵守 Workspace Trust，并转发 config 与 active
  Context。
- 提供 restart server 与选择已配置 Context/Resolver value 的命令；resolved preview 使用标准 hover。
- 构建确定的 VSIX，并在 CI 的干净 VS Code test profile 中安装。
- 发布中英文安装、故障排查与功能文档。

验收：

- Extension code 不包含 DTCG parsing、Graph traversal、resolution 或 rename logic。
- Activation 只针对 DTCG JSON/configured workspace，且不写用户文件。
- VSIX 能启动 bundled server，并通过一次 edit/diagnostic/navigation smoke flow。
- M3 关闭不依赖 Marketplace credential 或发布。

#### M3-09 — Differential Proof、性能门槛与 `0.6.0` Release Candidate（P0）

交付：

- 在 deterministic 与 seeded edit sequence 上运行 CLI/LSP differential，包含 invalid/recovery 与 Context
  change。
- 对 cold startup、one-file edit、high-fan-out edit 与 cancellation 设置 semantic-work gate，并发布匹配
  环境的 p50/p95 与 peak-memory 证据。
- 增加 protocol/process test、公共 declaration/schema lock、package/VSIX consumer smoke、中英文迁移与
  release 文档，以及 Changeset。
- 从隔离 clean worktree 验证同步版本的 `0.6.0` npm candidate 与 VSIX。

验收：

- 每项官方 M3 退出条件都有自动化证据，且 M1/M2 无未解释回归。
- 六个公开 package 通过 packed-consumer verification；VSIX 通过 clean-profile install/activation smoke。
- Release workflow 验证 registry content、provenance、目标 dist-tag 与六个 annotated package tag 后，
  才能关闭 M3。

## 9. 依赖与关键路径

```text
M2 published baseline
        │
        ▼
M3-00 RFC/baseline → M3-01 source index ──────┬→ M3-02 rename planner ───────┐
                                              │                              │
                                              └→ M3-03 server lifecycle      │
                                                        │                    │
                                                        ▼                    │
                                              M3-04 diagnostics/cancellation │
                                                        │                    │
                                          ┌─────────────┴─────────────┐      │
                                          ▼                           ▼      │
                                  M3-05 navigation            M3-06 hover    │
                                          └─────────────┬─────────────┘      │
                                                        ▼                    ▼
                                                  M3-07 edits/rename
                                                        │
                                                        ▼
                                                  M3-08 VS Code
                                                        │
                                                        ▼
                                                  M3-09 release gate
```

- M3-01 是所有 cursor-based feature 的语义前置。
- Source-index contract 接受后，M3-02 可以与 server skeleton 并行推进。
- M3-04 是首个端到端垂直切片，也是所有用户查询功能的前置 Gate。
- M3-05 与 M3-06 可以并行；M3-07 依赖 rename planner 与稳定调度。
- M3-08 只消费已经完成的标准协议，不能成为第二套实现。

## 10. 建议实现切片

| 顺序 | 切片            | 主要产物                                                | 合并门槛                        |
| ---- | --------------- | ------------------------------------------------------- | ------------------------------- |
| 1    | 契约与证据      | RFC、protocol corpus、Unicode/invalid fixture、baseline | 路线图能力全部完成映射          |
| 2    | Editor Query    | 不可变 source index 与 cursor fact                      | range 与 semantic-role 测试     |
| 3    | Rename planner  | 原子 edit 与 Backend preview                            | virtual recompile differential  |
| 4    | Server skeleton | package、stdio、workspace lifecycle                     | process init/open/shutdown test |
| 5    | Diagnostic loop | overlay、latest-wins、recovery、cancellation            | CLI parity 与 race matrix       |
| 6    | Navigation      | definition、references、symbols                         | Core/LSP result parity          |
| 7    | Insight         | completion 与 Context-aware hover                       | resolve/explain parity          |
| 8    | Safe edits      | rename 与 code action                                   | stale/digest/collision matrix   |
| 9    | VS Code client  | 薄 extension 与 VSIX                                    | clean-profile smoke test        |
| 10   | Release gate    | differential、budget、contract、package                 | M3 退出条件全部通过             |

每个切片都包含实现、聚焦测试与中英文文档。公共行为变化必须包含 Changeset。每个切片最多引入一层新公共
契约。

## 11. M3 验收矩阵

| 官方退出条件                                                  | 必需的自动化证据                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| LSP 与 CLI 对同一 snapshot 返回相同 diagnostics               | 共享 fixture runner 比较 normalized Diagnostic v1 fact、code、fingerprint、location、related information 与 fix |
| Rename 在写入前发现 canonical 与 Backend collision            | Core planner matrix、virtual recompile、全部 configured Backend preflight 与 process-level no-write assertion   |
| 无效 JSON 不导致崩溃且修复后自动恢复                          | open/change/recover protocol transcript、当前 version diagnostic assertion 与 server-process liveness check     |
| Benchmark 覆盖 cold start、one-file edit 与 high-fan-out edit | checked-in fixture、semantic-work budget、p50/p95 latency、peak memory 与 cancellation observation              |
| Protocol layer 不复制 Frontend 或 Graph 逻辑                  | import-boundary test、source scan、Core/LSP differential query 与 architecture review                           |

额外 release gate：

- Multi-root workspace 隔离且确定。
- UTF-16/CRLF/URI range conversion 精确。
- Superseded revision 不能发布 diagnostics、hover、navigation 或 edit。
- Context/Resolver change 与直接 Core query、Session metrics 一致。
- Code action 与 rename 受 digest/version guard，server 不直接写文件。
- 全部 M1/M2 test、schema、packed package、performance gate 与 release integrity check 继续通过。

## 12. 立即执行的下一步

M3-02 已完成。启动 M3-03：创建公开 language-server package，实现 trusted multi-root workspace
lifecycle 与 open-buffer precedence，并保持 latest-work revision ordering。Protocol handler 必须消费已接受
的 Core source-index 与 rename-plan contract，不得自行解析 Token 语义。

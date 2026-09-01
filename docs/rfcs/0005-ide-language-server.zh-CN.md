# RFC 0005：IDE 与 Language Server 语义

[English](0005-ide-language-server.md)

- 状态：M3-00 已接受
- 里程碑：M3-00 至 M3-09
- 更新时间：2026-09-01

## 摘要

tokenc Language Server 是现有编译器之上的协议适配层。每个 trusted workspace folder 拥有一个
`CompilerSession`；diagnostic、navigation target、completion、hover、rename 与 code action 全部从当前
不可变 Snapshot 和 Core 持有的 source fact 投影得到。

M3-00 固定 Workspace Trust、document identity、UTF-16 position mapping、open-buffer precedence、revision
ordering、cancellation、invalid-document behavior、editor symbol role 与 atomic rename。它增加人工编写的
protocol fixture、Core draft contract 与 LSP 实现前性能基线，但不创建生产版 language-server package。

## 用户问题

Design Token 作者目前必须离开编辑器运行 `tokenc check`、`explain` 或 `usages`。有效的编辑器集成必须从未
保存文本回答，并在 JSON 暂时不完整时持续恢复。它不能与 CLI 给出不同答案、应用 partial rename、显示来自
过期 revision 的 resolved value，也不能在未经信任时执行 workspace code。

LSP 还引入一次性 CLI 不存在的失败模式：edit 与 filesystem event 会竞争、request 可能晚于产生它的
document version、多个 workspace folder 可能有相同相对路径，而且协议 position 按 UTF-16 code unit 而非
byte 或 Unicode code point 计数。这些属于语义约束，而非 UI 细节。

## 术语

- **Workspace coordinator：** 每个 LSP workspace folder 独享的 host-owned state。
- **Overlay：** 打开文档的最新完整文本，它覆盖磁盘内容。
- **Requested revision：** 接受输入事件时分配的单调递增 workspace 编号。
- **Published revision：** 可以回答请求或发布 diagnostics 的最新 requested revision。
- **Document version：** client 为每个打开文本提供的单调递增版本。
- **Current invalid Snapshot：** 表示最新输入但带有 diagnostics、无法提供 resolved/Backend fact 的已提交
  Snapshot。
- **Editor source index：** Core Frontend 生成的不可变、transport-neutral declaration 与 reference
  occurrence。

## 固定决策

### 1. CompilerSession 仍是唯一语义生命周期

每个 workspace coordinator 拥有一个 `CompilerSession`，并把 trusted config、filesystem state、overlay
与 active Resolver input 转换成原子 Session transaction。Coordinator 不自行构造 `TokenNode`、edge、
resolved value、diagnostic 或 Backend symbol。

每项功能在查询前捕获一个 Snapshot reference，一份多阶段响应不能混用不同 revision 的 fact。Multi-root
client 使用独立 coordinator；两个 root 中相同的相对路径不能共享 cache 或 identity。

Language Server 可以拥有 scheduling、URI conversion、logging 与 protocol serialization；Parser、linker、
Graph operation、Checker、Context resolution、incremental cache validity 与 Backend preparation 继续由 Core
负责。

### 2. Workspace Trust 先于 config 执行

`tokenc.config.ts`、`.mts`、`.js` 与 `.mjs` 是可执行代码。VS Code extension 只在获得 Workspace Trust 后
启动或启用对应 workspace。通用 LSP client 通过 initialization/configuration 显式声明 trusted；缺少声明
即视为 untrusted。

Untrusted coordinator 可以报告 config unavailable，但不得 import config、展开 source glob、初始化已配置
Backend，也不能仅凭 filesystem path 推断安全。Trust 按 workspace folder 隔离且可以撤销；撤销后必须关闭
Session 并清除已发布结果。

Server 不执行 Git revision 或其他 workspace 中的 config。M2 的 trusted-configuration boundary 继续作为
权威规则。

### 3. Open buffer 是权威内容

已配置 source identity 的优先级为：

```text
latest accepted open-buffer version > latest accepted filesystem content > absent
```

协议适配层把 LSP incremental change 应用到自身 buffer，再将完整结果作为单个 `DocumentChange` 交给 Core，
使编辑协议语义不会泄漏进编译器。关闭文档会删除 overlay，并通过一次原子 transaction 恢复当前磁盘文档；
若文件已不存在，则删除该 source。

Config change 会重建 trusted project input，并在一次 transaction 中同时提交 config 与 document change。
Watcher 继续排除 Backend 生成路径。不能安全分类的 event 触发保守 project reload，不执行不完整猜测。

### 4. Document identity 与 position 必须规范化

Core document identity 继续是由 host 规范化的字符串。LSP adapter 负责 canonical file identity 与 normalized
`file:` URI 之间的转换。Percent encoding 只解码一次；path separator、drive-letter case 与平台大小写规则由
同一个经过测试的 mapper 处理。M3 默认不支持非 file URI，除非 host 显式提供其内容。

LSP 3.17 position 使用从零开始的 UTF-16 code unit。Core `SourceLocation` 保持从一开始的显示 line/column，
以及从零开始的 JavaScript string offset/length。Adapter 必须使用生成 Snapshot 时完全相同的 content 与
document version 做映射，不能对更新后的 buffer 使用旧 range。CRLF 是一个换行符，而 carriage return 仍计入
上一行的 offset span；astral character 计为两个 UTF-16 code unit。

### 5. Revision 采用 latest-wins

每个接受的输入事件分配 requested revision。任何时刻最多一个 Session transaction 提交；更新 revision 会
abort 旧的 pending work，并成为唯一允许发布的 revision。

异步操作完成本身不足以发布结果。发送 diagnostics 或 response 前，coordinator 立即验证：

- workspace 仍处于 active；
- captured requested revision 等于最新 requested revision；
- 所有相关 open document 仍处于 captured version；
- Snapshot 是 coordinator 当前 committed Snapshot。

任一检查失败即丢弃结果。显式 request 按 method 返回 LSP cancellation 或 empty/unavailable；notification
不发布任何内容。

### 6. Cancellation 不能提交 partial state

Coordinator 用 `AbortController` 中止 superseded work。`CompilerSession.apply()` 已保护异步加载，并仅在
prepared build 成功后提交。M3 可以在高成本 compiler stage 和有界 traversal 之间增加 cooperative abort
checkpoint，但 cancellation check 不能使输出依赖时序。

被 abort 的 transaction：

- 不替换 `currentSnapshot` 或 `lastSuccessfulSnapshot`；
- 不更新 published revision/document version；
- 不发布 diagnostic 或 edit；
- queue 仍能接受下一项 transaction。

M3-00 active-loader benchmark 测量当前已支持的 cancellation acknowledgement，不声称已经能中断同步 CPU
工作。

### 7. 当前无效输入不能被陈旧成功结果替代

Session 会为当前无效源码提交 invalid Snapshot，只把上一个成功 Snapshot 保留为显式历史。Server 发布当前
invalid Snapshot 的 diagnostics；不得从保留的成功 Snapshot 回答 resolved-value、Backend、hover 或 rename，
除非未来协议明确把数据标记为 stale，而 M3 不定义这种协议。

Core 可以公开在无效输入下仍然可靠的 source fact。Partial source-index entry 只能携带语法可证明的 identity/
range，不能虚构 target、Context condition、type 或 resolved value。不支持的请求返回 null/empty/unavailable，
而不是抛异常。

文本修复并生成 valid Snapshot 后，下一个 published revision 自动替换 invalid diagnostics；普通语法恢复不需要
重启。

### 8. Editor source index 是 Core contract

Frontend 已拥有 JSON syntax node、Token declaration、dependency occurrence、field path 与 source location。
它将发布不可变 index，而不是让 Language Server 再次解析源文本。

Draft `EditorSymbolV1` role 为：

| Role           | 含义                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `declaration`  | Canonical Token declaration key；owner 与 target 均为声明的 Token。     |
| `alias`        | 指向 canonical Token 的 curly-alias occurrence。                        |
| `json-pointer` | 规范化为 owning Token/component target 的 DTCG `$ref` occurrence。      |
| `inheritance`  | 指向 inherited Token/group source fact 的 group `$extends` occurrence。 |

每项包含 owner、target、精确 source span、field path 与可选 canonical Context predicate。排序依次为 document
identity、source offset、role、owner、target。除非不同 role 表示不同语义 occurrence，否则禁止重复 source
span。

Position lookup 先选择包含光标的最窄 occurrence，再使用上述规范顺序。Document/workspace symbol 来自同一组
declaration entry。Definition/reference 按 canonical target identity 关联；Graph query 继续作为 semantic usage
与 Context filtering 的权威。

### 9. Diagnostics 保留 Diagnostic v1 identity

LSP adapter 不重新分类 Diagnostic v1：

| Diagnostic v1               | LSP                    |
| --------------------------- | ---------------------- |
| `severity`                  | `DiagnosticSeverity`   |
| `code`                      | `code`                 |
| documentation URL           | `codeDescription.href` |
| message                     | `message`              |
| primary source              | `range`                |
| related sources             | `relatedInformation`   |
| fingerprint 与 fix identity | `data`                 |

CLI/LSP parity 在 display/transport projection 之前比较 normalized Diagnostic v1。只有 source 位于目标
workspace 外时，LSP 才能省略 diagnostic；不得改变 code、severity、fingerprint 或 source range。

M3 使用 push diagnostics。以后可以增加 pull diagnostics，但不能改变 compiler semantics。

### 10. Completion、Navigation、Symbol 与 Hover 只是投影

Completion 只限于已识别 alias/reference position。Candidate identity 来自 Core Query 与 source-index fact。
Adapter 可以执行 LSP prefix filter 和 result limit，但不能发明 alias 或推导第二套 scope model。

Definition 解析精确 occurrence target。References 在请求时组合 declaration 与经过同一 Context predicate
语义过滤的 indexed occurrence。Document/workspace symbol 反映 canonical hierarchy 与 source ownership。

Hover 包含 Query/explain 提供的 canonical ID、type、selected source expression、resolved value、effective
Context 与 provenance。当前 Snapshot 无效时，省略 unavailable semantic field，并可显示相关当前 diagnostic；
不得替换为陈旧成功值。

### 11. Rename 是原子的 Core plan

Rename 只能从无歧义 declaration/reference 开始。Core 使用 canonical Token ID authority 校验 replacement，
查找每个受支持 occurrence，构造无 overlap、带 digest guard 的 `TextEdit`，在内存 document set 上应用 edit、
重新编译，并 prepare 全部 configured Backend。

`RenamePlanV1.status`：

- 仅当 coverage 完整、virtual Snapshot 有效且 Backend preparation 无 collision/invalid-symbol diagnostic 时为
  `ready`；
- replacement 无效、canonical/Backend collision、edit overlap 或 unsupported occurrence 时为 `rejected`；
- 当前 Snapshot 或所需 document content 无法证明完整计划时为 `unavailable`。

Server 只把当前的 `ready` plan 转换成 `WorkspaceEdit`，并在返回前立即复查 workspace revision、document
version 与 content digest。Server 本身不写文件。

JSON Pointer escaping 必须结构化处理：path segment 由 Core pointer authority decode 后再 encode。禁止文本
search-and-replace。

### 12. Code Action 复用已验证 Fix

Code action 是 Diagnostic v1 fix 的视图。Diagnostic registry 继续决定哪些 code 可以携带 fix。Server 查找
当前 diagnostic fingerprint，检查 edit order/non-overlap、document version 与 digest，再返回标准 quick fix。

Stale、missing、suppressed 或已经不匹配的 diagnostic 不产生 action。M3 action 不修改 config、不 emit
generated file、不运行 shell command，也不调用任意 extension code。

### 13. Protocol 与 package 边界

第一版公开 `@tokenc/language-server` 面向 Node.js 与 LSP 3.17，提供 stdio executable 和供 process/in-memory
测试使用的 library factory。它只声明已经实现的标准 capability：

- incremental text sync，并在内部转换为 complete-buffer Session update；
- push diagnostics；
- completion、definition、references 与 hover；
- document/workspace symbols；
- prepare rename 与 rename；
- code actions。

VS Code extension 只包含 activation、server launch、Workspace Trust、configuration forwarding、Context
selection、restart/status command 与 packaging。可测试 VSIX 是 M3 artifact，但关闭里程碑不要求 Marketplace
发布。

## Draft contract 与 protocol corpus

M3-00 将非公开 draft schema 放在：

- [`editor-symbol-v1.schema.json`](../schemas/drafts/editor-symbol-v1.schema.json)
- [`rename-plan-v1.schema.json`](../schemas/drafts/rename-plan-v1.schema.json)

人工编写的 protocol authority 是
[`corpus.v1.json`](../../benchmarks/fixtures/editor-protocol/corpus.v1.json)。它覆盖 trusted/untrusted
initialization、valid open、invalid/recovery edit、overlay close、diagnostics、completion、navigation、symbol、
Context-aware hover、成功与拒绝 rename、current/stale code action、latest-wins cancellation、multi-root
isolation，以及 UTF-16/CRLF range。

这些 shape 在 M3-01/M3-02 期间可以不承诺兼容地调整。只有完成实现、schema validation、deterministic test
与 public-contract lock 后，才能成为公开契约。

## 进入 M3-01 前的 Gate checklist

| Gate               | 决策                                                             | 证据                                   |
| ------------------ | ---------------------------------------------------------------- | -------------------------------------- |
| Semantic authority | 只使用 Snapshot/Query/Session；protocol 侧没有 Parser 或 Graph。 | Import boundary 与 differential test。 |
| Trust              | 可执行 config 需要 per-workspace 显式信任。                      | Trusted/untrusted transcript。         |
| Buffer precedence  | 最新 accepted open buffer 覆盖磁盘，直到 close。                 | Open/change/close transcript。         |
| Position model     | LSP UTF-16 对生成结果的精确 versioned text 做映射。              | Unicode、escape 与 CRLF anchor。       |
| Revision ordering  | 只有 latest requested/current committed revision 可以发布。      | Cancellation transcript 与 race test。 |
| Invalid state      | 发布当前 error；resolved/Backend fact unavailable。              | Invalid/recovery transcript。          |
| Rename atomicity   | Edit 暴露前完整 virtual recompile，并 preflight 全部 Backend。   | Ready/collision/stale fixture。        |
| Server writes      | Rename/code action 只返回 plan。                                 | Process-level filesystem hash check。  |

## 性能基线

M3-00 在现有隔离 benchmark runner 中增加五个 LSP 实现前 case：

- 1,200 Token 的 cold Session startup 与代表性 Query projection；
- 同一 layered project 的 one-file warm update；
- 发布 invalid JSON 后恢复有效输入；
- 一个 primitive edit 影响 2,000 个 direct consumer；
- 中止 active loader-backed transaction，且不提交 Session state。

Warm case 的 fixture generation 与 Session initialization 位于计时区间外。每份 report 记录 fixture digest、
raw timing sample、compiler stage timing、Session semantic counter、semantic hash、p50/p95 与隔离进程 peak
RSS。Wall-clock budget 在 M3-09 获得匹配 CI 证据前只作参考；精确 Token/reference/change/affected/recomputed
计数从现在开始作为 Gate。

Cancellation case 测量目前支持的 asynchronous loader boundary，不声称能够中断同步 parser CPU 工作。
M3-04 必须依据基线决定需要增加 cooperative Core checkpoint 的位置。

## 测试计划

- 验证人工编写的 protocol corpus 覆盖每个必需 IDE 行为。
- 验证 Workspace Trust、file URI containment、唯一 transcript identity 与非空 expected outcome。
- 锁定含 astral Unicode 的 CRLF 文本之精确 UTF-16 offset/position。
- 用当前 Core 编译 corpus 中的 valid、invalid 与 recovered text。
- 执行全部五个 baseline invocation，并在 semantic counter 或 hash 漂移时失败。
- 验证两份 draft schema 都是 strict、versioned top-level contract。
- M3-01 至 M3-07 必须把每项人工 transcript 转为 Core 或 process-level differential test，不能用捕获的实现
  输出替换 expectation。

## 被否决方案

- **用 JSON language service 作为语义引擎：** 无法复现 tokenc linking、Context、Resolver、diagnostic 与
  Backend rule，会导致 CLI/LSP 漂移。
- **所有 workspace 共享一个全局 Session：** 相对路径、config、Context 与 cancellation 会跨 root 泄漏。
- **每次请求读取磁盘：** 会忽略未保存 edit，并产生依赖竞态的答案。
- **语法错误时使用最近有效 Snapshot：** 会把陈旧值呈现为当前事实。
- **让 server 应用 rename edit：** 绕过 client version check 与编辑器 transaction UX。
- **用文本替换实现 rename：** 无法正确处理 JSON Pointer escaping、component occurrence、Context 与
  Backend collision。
- **按 Unicode code point 计数：** LSP 3.17 position 使用 UTF-16 code unit。
- **先实现自定义协议/UI：** 在标准 LSP 行为被证明前就把语义绑定到单一编辑器。
- **要求 M3 发布到 Marketplace：** credential 与 store review 不能证明 compiler/protocol correctness；可
  复现 VSIX 足够。

## 开放问题

Gate 0 没有开放问题。M3-01 导出公共契约前，draft 字段只有在同步更新本 RFC、中文翻译、两份 draft schema、
protocol corpus 与测试时才允许修改。

## 明确不做

- M3-00 不创建生产版 `@tokenc/language-server` package。
- 不发布 VS Code Marketplace。
- 不实现 semantic token、formatting、inlay hint、color decorator、graph/diff Webview 或自定义 editor
  protocol。
- 不实现 persistent cache、worker pool、remote indexing 或 browser transport。
- 不实现通用 lint/importer/plugin API 或新 Backend 格式。

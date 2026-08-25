# M1 执行计划：稳定语义编译器 API

[English](M1-PLAN.md)

> 状态：计划就绪，尚未开始实现。更新时间：2026-08-25。
>
> 入口基线：M0 已按 [M0 验收记录](M0-ACCEPTANCE.zh-CN.md)完成，npm `latest` 为
> `0.3.0`。

## 1. 阶段结果

M1 的目标不是增加更多 Backend 或命令，而是把已经存在的正确性能力整理为稳定、可嵌入、可组合的公共
接口。阶段结束时，CLI 使用不可变语义快照与 Query API；同一边界已经能支持未来的 CI reporter 与
Language Server，但不会提前实现这些 M2/M3 客户端。

M1 必须交付五个用户可感知的结果：

1. 依赖关系可以按 Context 查询，不再只能看到所有分支合并后的边。
2. 任意 resolved value 都能通过稳定 trace 解释来源、覆盖选择和依赖路径。
3. 文件变化通过长生命周期 Session 原子地产生新 snapshot；旧 snapshot 仍可安全并发读取。
4. Backend 在 emit 前通过统一 capability 和 symbol contract 完成全部可表达性检查。
5. 增量结果通过 differential tests 证明与全量编译一致，并报告实际缓存与重算指标。

这五点直接强化 tokenc 相对 Terrazzo 的目标差异：tokenc 不以更多转换插件取胜，而以条件语义可证明、
变化可解释、增量行为可验证和编译器能力可嵌入取胜。

## 2. 当前基线与缺口

| 领域         | `0.3.0` 已有能力                                                                                         | M1 必须补齐的边界                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 条件正确性   | Checker 在有效 Context 投影中检测真实循环，并限制组合爆炸                                                | `TokenGraph` 仍只保存无条件 `TokenId → TokenId` 邻接关系，查询无法返回条件和引用来源          |
| 查询与解释   | `Compilation` 提供 definition、completion、resolve、explain；Graph 提供 dependencies、dependents、impact | 接口分散、Context 查询不完整、trace 尚无稳定 schema/version                                   |
| 增量编译     | `IncrementalCompiler` 只 parse 变化文件、patch Graph、复用未受影响的 Resolver 结果                       | 每次更新仍全量 relink 和扫描签名；结果是可替换的 mutable session state，而不是不可变 snapshot |
| Backend 安全 | `validate()`、名称碰撞 helper、输出路径碰撞保护已存在                                                    | capability 与 symbol allocation 仍由各 Backend 分别实现，没有共同 conformance contract        |
| Diagnostic   | 已有稳定 code、primary source、related location 和 suggestion                                            | 缺少 schema version、稳定 fingerprint、documentation URL、结构化 fix 和序列化契约             |
| 性能观测     | 有 compile timings、affected/recomputed 计数和合成 benchmark                                             | 缺少各阶段 hit/miss、重复采样、p50/p95、峰值内存及条件投影统计                                |
| 发布         | `0.3.0` 已通过 OIDC 发布并建立五个 tags                                                                  | 发布重试身份校验、ref/environment 约束和发布后自动验收仍需加强                                |

当前一次本地 benchmark 中，10k Token 场景的单点编辑只重算 12 个 Token，但耗时约 173 ms。这个结果
说明 M1 的性能工作必须覆盖 parse 之外的 relink、diff、Graph 和诊断成本，不能只优化 Resolver cache。

## 3. 范围边界

M1 包含：

- 条件边、Predicate algebra 与只读 Query API。
- Diagnostic、explain trace、Backend capability 和 symbol allocation 的公共契约。
- 不可变 `CompilationSnapshot`、长生命周期 `CompilerSession`、进程内 cache 和指标。
- CLI 与内置 Backend 向这些公共接口迁移。
- differential、conformance、property 和性能测试。
- 可注入的文档加载边界；Core 自身仍不执行网络请求。

M1 不包含：

- `tokenc diff`、SARIF、Pull Request 报告或 breaking-change policy；这些属于 M2。
- Language Server 或 VS Code extension；这些属于 M3。
- Terrazzo adapter、新 Importer、新 Backend 或持久化磁盘 cache。
- 任意对象 transform pipeline，或允许扩展修改已链接 snapshot。
- 在测量与 RFC 前开放任意布尔 Context 表达式。

## 4. 交付顺序

### Gate 0：发布治理与测量基线

#### M1-00 — 发布完整性收口（P0）

工作：

- 在 `publish.yml` 中增加可执行 preflight step；当 `github.ref != 'refs/heads/main'` 时非零退出，不能用会
  显示为绿色 skipped 的 job-level `if` 代替。
- 为 GitHub `npm` environment 配置 protected-branch deployment policy；存在独立维护者时必须设置
  reviewer，单维护者例外必须在 release record 中明确记录，不能以未保护 environment 隐式代替。
- 增加仓库内统一的 `verify-release` 命令，供本地和 workflow 共用：核对精确的五包集合与版本、内部
  依赖、请求的 dist-tag、本地 packed candidate 与 registry `dist.integrity`、provenance subject digest
  和 source commit，以及五个预期 annotated tag 是否都 peel 到发布提交。
- 已存在版本不再直接跳过；只有上述命令证明 published artifact 一致，才能作为幂等成功。
- 当相同版本已存在但请求的 dist-tag 不一致时，默认安全失败并给出明确的 promotion 操作。只有在单独
  评审的认证方案证明 trusted workflow 有权执行 `npm dist-tag` 后，才允许自动更新。
- 正确处理部分发布重试与 registry 有界最终一致性等待，不能接受不可验证 artifact。
- 通过 repository ruleset 防止 package tag 被改写。
- 将 release path 中所有 `uses:`（包括 checkout）固定到完整 commit SHA，并为 Dependabot 启用
  GitHub Actions ecosystem。
- 发布前运行 packed-tarball consumer smoke，发布后运行 registry-installed consumer smoke。

验收：

- 非 `main` ref 的 dispatch 在可见的 preflight step 中失败，且不会开始 publish。
- Registry fixture 覆盖“未发布”“已发布且一致”“artifact 不一致”“dist-tag 不一致”“部分发布”和
  “registry 延迟可见”。
- 测试会拒绝错误的 tarball digest、provenance subject/source commit、内部依赖、dist-tag、
  environment/ref policy、缺包、非 annotated tag 或 peel 到其他提交的 tag，不再出现绿色假成功。
- 一条文档化命令可复跑发布前/后验证，并由 CI/workflow 自动运行两种 consumer smoke。

依赖：无。它可与 M1-01 并行，本地 RFC 实验也可开始；但 M1-00 与 M1-01 都通过前，不合并新的公共
API 实现。

#### M1-01 — Characterization 与 benchmark 基线（P0）

工作：

- 为条件循环检查增加只读统计：候选区域数、相关维度、估算/实际投影数、提前退出和 limit hit。
- 把 benchmark 输出扩展为 JSON，并记录 commit、Node、CPU、warm-up、样本数、p50、p95、峰值内存、
  parse/link/graph/check/resolve/emit 时间和重算数量。
- 保留现有 small/wide/deep/fan-out fixture，新增多维 Context 与频繁 override fixture。
- 对固定 `dtcg-examples` 和至少一个可公开的代表性项目运行基线；没有真实数据时明确标注 synthetic。

验收：

- 同一命令可重复生成机器可读报告，结果不进入产品正确性判断。
- 16,384 投影上限的保留或调整有数据依据；调整必须带回归测试和 changeset。
- 建立 M1 后续 PR 的性能比较方法，但在重复测量前不发布对 Terrazzo 的速度结论。

依赖：无，可与 M1-00 并行。

### Gate 1：先冻结语义契约

#### M1-02 — 三份短 RFC（P0）

在改动公共类型前完成并审查：

1. **Conditional Graph RFC**：dependency occurrence 与 source、edge kind、raw selector 与有效条件、
   优先级覆盖、Predicate union/complement/empty/canonical DNF 或 edge splitting、
   `matches/intersect/subtract/isSatisfiable`、复杂度上限及兼容策略。
2. **Snapshot and Session RFC**：不可变 Graph revision、snapshot revision、更新事务、invalid snapshot 与
   last successful snapshot 的关系、并发读取、取消、loader 边界、cache ownership 与配置变化。
3. **Backend and Diagnostic RFC**：capability negotiation、symbol namespace、名称规范化、
   `prepare/preflight → BackendPlan → emit`、artifact path planning、Diagnostic v1、fingerprint、fix edit、
   序列化和弃用策略。

验收：

- 每份 RFC 都包含用户问题、失败模式、增量失效、诊断、兼容、测试和明确不做的方案。
- 解释 override 优先级如何从 raw selector 得到“该依赖真正生效的区域”；不能把 selector 简单等同于
  effective condition。
- Predicate 表示必须对“减去更高优先级获胜区域”产生的非凸并集闭合，不能把它近似成一个 conjunction。
- RFC 必须决定重复 dependency occurrence 是保留为多条 edge，还是聚合为一条带有序 source 列表的 edge。
- 明确旧 `compile`、`Compilation`、`IncrementalCompiler` 和 `TokenGraph` API 的迁移窗口。

依赖：Conditional Graph RFC 必须等待 M1-01 数据才能通过；Snapshot/Session 与 Backend/Diagnostic
RFC 可以并行起草。Gate 1 未通过前，不合并新的公共 API。

### Wave 1：条件语义与稳定事实模型

#### M1-03 — Dependency occurrence、Context Predicate 与条件边（P0）

交付：

- Frontend/Linker 在去重前保留每一次 dependency occurrence，包括 owner、base/override candidate identity、
  target、kind、field path、source range 与 source order。
- 对 empty set 和非凸并集闭合的内部规范化 `ContextPredicate`，支持匹配、求交、complement/相减、
  可满足性和稳定序列化。
- 带 `from`、`to`、`kind`、`condition`、`source` 的 `DependencyEdge`。
- Alias、JSON Pointer、inheritance 和 composite-field 边统一进入条件 Graph。
- Cycle checker 改为消费同一套边和 Predicate，不再维护独立的依赖选择逻辑。
- 保留旧的 ID-only adjacency 作为兼容视图，而不是第二份事实源。

验收：

- M0 所有循环 fixture 结果不变。
- 增加部分重叠 selector、被高优先级覆盖的边、缺省值、三维交集、同一 target 在不同 composite field
  中重复出现，以及 source range 断言。
- Predicate 运算包含 truth-table/property tests，排序和序列化在输入顺序变化时仍确定。
- 复杂度上限在分配前检查，并返回稳定 Diagnostic。

依赖：M1-02 Conditional Graph RFC。

#### M1-04 — 公共 Query API 与 Explain Trace v1（P0）

交付：

- 只读 Query facade，提供 token、definition、dependencies、usages、impact、resolve 和 explain。
- dependency/usages/impact 同时支持具体 Context 与 Predicate 范围查询，并返回 edge source。
- `ExplainTraceV1` 记录 base/override 选择、precedence、Context、依赖步骤、Resolver 步骤和最终值。
- 所有集合有稳定排序；公共返回值不暴露可变 Map/Set。

验收：

- 同一只读 facade、同一查询的字节级 JSON 序列化确定。
- 互斥 Context 下 usages/impact 不产生假阳性；不指定 Context 时明确返回条件，而不是丢失条件。
- CLI `explain`、`usages`、`graph` 的现有结果有兼容 fixture。

依赖：M1-03。

#### M1-05 — Diagnostic schema v1（P0）

交付：

- 版本化、可 JSON 序列化的 Diagnostic contract。
- 稳定 fingerprint、primary location、related locations、documentation URL、可选结构化 fixes。
- Diagnostic code registry，记录所属阶段、严重级别和是否允许 policy suppression。
- 旧 `suggestions: string[]` 的兼容或弃用路径。

验收：

- 相同行为在冷编译与增量编译中得到相同 fingerprint。
- 仅移动行号时，语义身份不变的 Diagnostic 不被误判为全新问题；内容真正变化时可区分。
- Schema 有 golden JSON、版本字段和兼容性测试；Core 不输出终端文本。

依赖：M1-02 Backend and Diagnostic RFC。可以与 M1-03 并行。

#### M1-06 — Backend Plan、共享 Symbol Allocator 与 Capabilities（P0）

交付：

- 公共但只读的 `BackendCapabilities`：Token type、reference strategy、Context output model。
- `SymbolAllocator` 支持 namespace、大小写策略、Unicode normalization、保留字和显式 rename map。
- 在 Snapshot 出现前先从现有 `Compilation` 适配出不可变 `CompilationIR`，并作为 Backend 唯一输入；
  该 IR 不暴露可变 Graph 或 Resolver internal。
- `prepare/preflight(ir: Readonly<CompilationIR>) → BackendPlan` contract；plan 包含 Diagnostic、已分配
  symbol table、权威且有序的 artifact identity/path，以及 Backend 自有不可变数据；emit 只消费有效 plan。
- `emit(plan)` 必须精确返回 plan 已声明的 artifact，不得新增或改名 path。prepare/emit Diagnostic 属于
  本次操作结果，不修改输入 IR 或后续 snapshot。
- CSS、Tailwind、TypeScript 迁移到 IR/plan contract 与同一 allocator；Backend 仍负责平台命名规则。
- 一套跨 Backend conformance suite，防止 collision、unsupported value 和 partial emit 回归。

验收：

- 每个 Backend 内可发现的 symbol、值级可表达性、capability、path validity 与 plan 内碰撞 error，必须在
  该 Backend 的 `emit()` 调用前完整返回。
- 多错误输入一次报告全部可发现问题，且不产生任何 output。
- Conformance test 断言 emit 的 artifact identity/path 集合与 plan 完全相同；任何未规划产物都属于契约
  失败。
- 三个内置 Backend 与一个参考 custom Backend 通过共享 conformance suite；M0 golden output 除明确
  changeset 外不变化。

依赖：M1-02 Backend RFC、M1-03 条件事实与 M1-05 Diagnostic v1；可与 M1-04 并行。

### Wave 2：Snapshot、Session 与真正的增量边界

#### M1-07 — 不可变 CompilationSnapshot（P0）

交付：

- Snapshot 固定 revision、documents、diagnostics、不可变 Compilation IR、query facade 和 semantic
  configuration identity。
- Graph revision 必须不可变或 copy-on-write；Snapshot 不能直接包装当前会原位执行 `TokenGraph.patch()`
  的对象。
- Snapshot 只读并可在 Session 更新后继续使用；内部 cache 不改变可观察结果。
- `emit(backends)` 针对一个 snapshot 运行 preflight，在任何 emit 前拒绝跨 Backend path collision，
  随后只原子生成已规划产物。
- Backend 操作 Diagnostic 与 snapshot 固定的语义 Diagnostic 分离。
- 现有 `Compilation` 通过适配层迁移，避免一次性破坏用户代码。

验收：

- 对同一 snapshot 并发执行 resolve/explain/usages/emit，结果稳定且没有交叉污染。
- 在 Session 出现前先用最小 builder harness 从变化输入构造第二个 snapshot，并证明第一个 snapshot 的
  Graph、Query 和序列化结果字节不变。
- unsuccessful snapshot 只暴露自身 Diagnostic 并拒绝 emit，不会回退到其他 revision 的数据。
- 两个本身有效的 Backend plan 发生跨 Backend 路径碰撞时，两个 Backend 的 emit 都不得调用。

依赖：M1-03、M1-04、M1-05、M1-06。

#### M1-08a — 无缓存 CompilerSession 与 differential oracle（P0）

交付：

- 以正确性优先、不启用阶段 cache 的 `CompilerSession`，支持原子的 add/update/remove/reconfigure
  transaction。
- 可注入 `DocumentLoader`，支持文件、虚拟或宿主提供的内容；Core 不直接增加网络 IO。
- 失败更新为最新 source 发布 current diagnostic snapshot；可选 `lastSuccessfulSnapshot` 必须显式访问，
  不得混入当前 Query 或 emit。
- 现有 `IncrementalCompiler` 成为无缓存 Session 上的兼容 facade。
- 驱动该 Session 的可复用 full-vs-incremental oracle。
- 比较 normalized diagnostics、conditional edges、有限 fixture 中每个已枚举 Context 的 resolved values、
  trace 与 output bytes；timing/cache counter 不参与比较。
- 覆盖 add、update、remove、invalid/recover、configuration 与 Resolver 变化的确定性种子 mutation corpus。

验收：

- 种子 corpus 对全量编译不存在未解释 mismatch。
- 规范化规则有文档，普通自动化测试可以直接调用 oracle。
- 文件新增、删除、无效 JSON、恢复、Resolver 变化和 Backend 配置变化都有 transaction 与 differential
  test。
- Session 更新（包括失败更新）后，保留的旧 snapshot 仍保持不变。
- AbortSignal 取消不发布半成品 snapshot，后续更新仍可继续。
- 无缓存 Session 与 oracle 必须在任何 cache 或 invalidation 优化前合并。

依赖：M1-04、M1-05、M1-06 与 M1-07。

#### M1-08b — 阶段 cache 与指标（P0）

交付：

- Parser、Linker、conditional Graph 与 Resolver 的明确 cache ownership/key。Backend plan 默认不缓存；
  只有 Backend 声明覆盖全部 option（包括用户 callback）的稳定 cache key 时才允许缓存。
- `SessionMetrics` 报告每阶段 hit/miss、reused/recomputed 和 invalidation reason。

验收：

- 修改单个文件时，未变化文件 parse count 为零。
- 局部变化不再无条件 relink 所有文档；必须由 metrics 与测试证明实际复用。
- 每一项 cache 或 invalidation 改动在合并前都通过 incremental-vs-full comparison。
- Cache 指标与 oracle 观测到的 changed、reused、recomputed semantic fact 精确对应。

依赖：M1-08a。每项 cache 优化都继续由 oracle 门禁。

### Wave 3：迁移与证明

#### M1-09 — CLI 迁移与公共消费者边界锁定（P0）

交付：

- `build`、`check`、`dev` 使用 `CompilerSession` 与 snapshot emit。
- `explain`、`usages`、`graph` 只通过 Query API，不直接读取可变 Graph/Resolver internals。
- CLI JSON 输出使用版本化 Diagnostic/Trace schema。
- 删除或标记所有私有旁路，并增加 architecture test，防止 CLI 或已由 M1-06 迁移的内置 Backend 重新
  引入旁路。

验收：

- CLI 与直接 Core API 对同一输入返回相同 Diagnostic fingerprint、trace 和 Context 查询结果。
- dev 模式覆盖配置 reload、无效输入恢复、连续快速更新和取消。
- `rg`/dependency rule 能证明 CLI 与内置 Backend 未导入被标记为 internal 的模块。

依赖：M1-04、M1-06、M1-07、M1-08b。

#### M1-10 — Differential proof、性能门槛与 API 稳定文档（P0）

交付：

- 扩展 M1-08a 已建立的 incremental-vs-full oracle，覆盖更大的 add/update/remove、invalid/recover、
  config 与 Resolver mutation corpus。
- 比较 normalized diagnostics、Graph edges、有限 fixture 中每个已枚举 Context 的 resolved values、
  trace 和输出字节；只忽略 timings/cache counters。
- 加入 snapshot 并发、determinism、high fan-out 和 Context explosion 测试。
- 发布 API stability/deprecation 文档、M1 migration notes 和公开示例。
- 根据 M1-01 基线制定有依据的 regression threshold，并在 CI 中运行稳定的非噪声子集。

验收：

- differential mismatch 为零。
- M1 路线图五项退出条件全部有自动化证据。
- 公共 API 类型和 machine-readable schema 通过 API snapshot 或兼容检查锁定。
- release candidate 批准前，`pnpm verify`、package dry-run、packed-tarball smoke test 与
  clean-worktree gate 全部通过。
- 发布后，registry-installed smoke test 与 M1-00 post-publish 完整性检查通过，才关闭 M1 里程碑。

依赖：所有前置 M1 任务。这是 M1 release candidate 的唯一出口；发布和 registry 复验是关闭里程碑的
最后一步。

## 5. 依赖关系与并行策略

```text
M1-00 release integrity ───────────┐
                                   ├→ Gate 1 ─┬→ M1-03 occurrences/graph ─┬→ M1-04 query/trace ─┐
M1-01 measurements → M1-02 RFCs ──┘          │                           └→ M1-06 backend plans ─┤
                                              └→ M1-05 diagnostics ────────────────┘             ▼
                                                                                       M1-07 snapshot
                                                                                              │
                                                                                              ▼
                                                                                M1-08a uncached session/oracle
                                                                                              │
                                                                                              ▼
                                                                                     M1-08b caches/metrics
                                                                                              │
                                                                                              ▼
                                                                                   M1-09 consumer migration
                                                                                              │
                                                                                              ▼
                                                                                      M1-10 proof/release
```

- M1-00 与 M1-01 可以立即并行。
- M1-02 RFC 也可立即起草；进入 Gate 1 的箭头表示批准/公共 API 合并资格，不代表禁止提前起草。
- RFC 评审后，M1-03 与 M1-05 可以并行。
- M1-06 可在 M1-03 和 M1-05 后与 M1-04 并行；它以不可变 Compilation IR 为输入，不依赖后续才出现
  的 `CompilationSnapshot` 类型。
- Snapshot、Session 和消费者迁移保持顺序，避免同时维护两套不稳定公共模型。

## 6. 建议 PR 切分

| 顺序 | PR                    | 主要内容                                                             | 合并门槛                                 |
| ---- | --------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| 1    | Release integrity     | ref/environment guard、幂等验证、post-publish checks、Action pinning | registry fixture 与 workflow 静态验证    |
| 2    | Measurement baseline  | benchmark JSON、Context projection metrics、代表性 fixture           | 可重复报告与无语义变化证明               |
| 3    | RFC bundle            | 三份 RFC 与 migration policy                                         | 关键开放问题全部有决定或显式延期         |
| 4    | Occurrences/predicate | occurrence provenance 与 union/complement 闭合的 Predicate algebra   | source 保留断言与 property tests         |
| 5    | Conditional edges     | edge model、索引、cycle 迁移                                         | M0 fixture 与精确 source assertions      |
| 6    | Query and trace       | Query facade、Context usages/impact、Trace v1                        | deterministic JSON fixtures              |
| 7    | Diagnostic v1         | fingerprint、fix、registry、serialization                            | cold/incremental identity tests          |
| 8    | Backend contracts     | immutable IR、BackendPlan、权威路径、allocator 与 conformance        | 内置/custom plan-to-emit 完全一致        |
| 9    | Snapshot              | immutable revision、并发读取与跨 Backend 原子 planning               | 隔离与跨 Backend zero-emit tests         |
| 10   | Uncached Session      | transaction、loader、失败语义与 differential oracle                  | 完整 mutation corpus 为零 mismatch       |
| 11   | Caches and metrics    | 阶段 ownership、指标与精确失效                                       | oracle-backed cache assertions           |
| 12   | CLI/boundary lock     | CLI 切换到公共 API；锁定 CLI 与内置 Backend import boundary          | parity 与 internal-import boundary tests |
| 13   | M1 release gate       | API docs、deprecation、bench threshold、changeset                    | 全部退出条件通过                         |

每个 PR 至多引入一个内聚的公共 API 层，并同时包含测试和文档。不得先公开类型名称、再在后续 PR 中反复
改变其语义。

## 7. M1 验收矩阵

| 官方退出条件                              | 必须提供的自动化证据                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| 单文件编辑不重新解析未变化文件            | parser cache counter + identity fixture，断言 unchanged parse count 为 0                    |
| 增量输出等于全量编译                      | 确定性 mutation corpus + property sequence，比较 diagnostics、edges、values、trace、outputs |
| 同一 snapshot 并发读取确定                | 并行 query/resolve/emit 测试与旧 snapshot 隔离测试                                          |
| Backend 在 emit 前发现全部 planning error | 内置/custom conformance 覆盖 symbol、value、capability、path 与 plan-to-emit 完全一致       |
| 公共消费者不使用私有旁路                  | CLI/Core parity + internal-import boundary check，覆盖 CLI 与内置 Backend                   |

除上述条件外，M1 release candidate 还必须满足：

- 没有未解释的 M0 fixture 回归。
- Diagnostic 和 trace JSON 有 schema version 与兼容说明。
- 性能报告同时给出 p50、p95、峰值内存和实际重算数量。
- 没有以增加新 Backend、LSP 或 adapter 来替代 Core API 收口。

## 8. 立即开始的三项工作

1. 完成 M1-00，先消除下一次发布的不可验证状态。
2. 完成 M1-01，并用数据回答 Context projection 与全量 relink 的真实成本。
3. 基于测量结果提交 M1-02 RFC；RFC 合并后再开始条件边公共模型。

后续实施状态只在本文件维护；总体产品方向与里程碑退出条件继续由
[路线图](ROADMAP.zh-CN.md)维护。

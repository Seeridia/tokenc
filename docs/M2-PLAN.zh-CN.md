# M2 执行计划：CI 与变更智能

[English](M2-PLAN.md)

> 状态：实现已完成。M2-00 至 M2-09 已通过 `0.5.0` release candidate 验收；最终关闭里程碑前仍需
> 获得授权后执行发布与发布后验证。更新时间：2026-09-01。
>
> 入口基线：M1 实现与本地 `0.4.0` release candidate 已按
> [M1 验收记录](M1-ACCEPTANCE.zh-CN.md)完成。M2 设计与 fixture 可以立即推进；公开 M2 API 的发布工作
> 需等待获得授权的 `0.4.0` 发布及发布后验证。
>
> 目标版本线：`0.5.0`。具体 release tag 只在发布 Gate 决定。

## 1. 阶段结果

M2 把 M1 的语义编译器转化为可在本地与 CI 中保护现有 Design Token 流水线的变更智能层。它必须用
稳定、机器可读的证据回答四个问题：

1. 两个项目状态之间发生了哪些语义变化？
2. 哪些 Token、Context 区域、Backend symbol 与 artifact 受到影响？
3. 哪些变化违反显式兼容策略？
4. CI 如何以确定性的 JSON、可读文本或 SARIF 发布这些发现？

第一个实现目标是对两个不可变 Snapshot 做纯比较。Git revision、CLI 渲染、policy、SARIF、Resolver
permutation 与互操作都是这一事实模型的消费者，不得形成另一套比较引擎。

## 2. M2 固定决策

以下决定用于防止里程碑分裂为彼此不兼容的 diff 实现：

1. **Core 比较 Snapshot，Core 不运行 Git。** `@tokenc/core` 接收两个不可变 Snapshot 与显式比较范围；
   repository discovery、revision、临时文件、终端输出和进程退出码属于 CLI。
2. **Semantic diff 与 policy 分离。** Diff 只记录事实，不决定严重级别；Policy evaluator 把事实转换为
   版本化 Diagnostic 和 pass/fail 结论。
3. **JSON 是权威报告。** Text 与 SARIF 都是同一 report model 的确定性投影，不得分别重新发现变化。
4. **Context coverage 必须显式。** M2 不得声称比较了未实际覆盖的 Context 或 Resolver input。无具体
   Context 的结构变化保留 Predicate，resolved comparison 列出精确 Context/permutation coverage。
5. **Impact 同时使用两个 revision。** 已删除依赖只能从 base Graph 发现，新增依赖只存在于 head Graph；
   propagated impact 必须是两侧条件遍历的并集，不能用 head-only 近似。
6. **Rename detection 仅为建议。** removed 与 added Token 只有在确定性语义签名支持时才成为 rename
   candidate；匹配有歧义时仍保持独立 add/remove 事实。
7. **默认不执行历史配置。** `tokenc diff` 只加载一份调用方显式信任的 analysis config，并把它用于两侧
   source revision。配置文件发生变化时，comparison 标记为 incomplete，policy 默认失败；只有调用方
   显式提供共同可信配置才能继续。这避免自动执行被比较 Git ref 中的任意代码。
8. **Permutation 枚举惰性且有界。** 默认只比较 effective Context；完整 Resolver 枚举必须显式指定上限，
   并报告 estimated、visited、filtered 与 truncated 数量。
9. **M2 不新增公开 package。** 纯比较和 permutation 契约进入 Core；Git、policy orchestration、reporter
   与命令进入 CLI。只有 M2 契约发布且证明存在独立消费者需求后，才重新评估 `@tokenc/ci` 拆包。
10. **不要求兼容 facade。** 项目仍处于 `0.x`；CLI 或 TypeScript 的有意破坏直接替换，并附 Changeset
    与迁移说明。已经发布的 v1 JSON payload 不允许静默破坏；不兼容 machine output 必须升级 schema。

## 3. 现有 M1 权威边界图

| 当前边界                          | M1 权威职责                                                     | M2 使用方式                                                    |
| --------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/core/src/snapshot.ts`   | 不可变 revision、documents、Diagnostic、Query、IR、Backend 入口 | Base/head comparison 输入，不增加可变 comparison state         |
| `packages/core/src/query.ts`      | 条件边、resolve、explain、usages、impact                        | 提供结构事实与 Context-aware traversal                         |
| `packages/core/src/backend.ts`    | Capability、symbol、artifact plan 与 preflight                  | 通过 `prepare()` 比较 symbol/artifact，不重复实现              |
| `packages/core/src/diagnostic.ts` | Diagnostic registry、fingerprint、fix 与序列化                  | Policy finding 与 SARIF identity 的事实源                      |
| `packages/core/src/session.ts`    | 原子更新、loader 边界与 cache ownership                         | 跨 revision/permutation 复用编译工作                           |
| `packages/core/src/loader.ts`     | 宿主提供的文档获取                                              | Git/worktree adapter 保持在 Core 外                            |
| `packages/cli/src/index.ts`       | Config 加载、文件写入、命令、渲染与退出码                       | 负责 Git acquisition、policy orchestration 与 report selection |
| `benchmarks/` 与 `contracts/`     | 可复现证据与公共接口 hash                                       | 扩展已有门禁，不创建平行的 M2 门禁                             |

M2 必须消费这些权威边界，不得增加另一套 Parser、Graph traversal、value Resolver、Backend naming pass、
Diagnostic fingerprint 实现或 release verifier。

## 4. 公共契约目标

M2 引入一个 comparison fact model，不公开内部 Graph 或 Resolver 对象：

```ts
interface SnapshotDiffV1 {
  readonly schemaVersion: "1";
  readonly status: "complete" | "incomplete";
  readonly base: SnapshotIdentityV1;
  readonly head: SnapshotIdentityV1;
  readonly coverage: ComparisonCoverageV1;
  readonly changes: readonly TokenChangeV1[];
  readonly impact: ImpactQueryV1;
  readonly backends: readonly BackendChangeV1[];
  readonly diagnostics: readonly DiagnosticV1[];
}

compareSnapshots(
  base: CompilationSnapshot,
  head: CompilationSnapshot,
  options?: SnapshotComparisonOptions,
): Promise<SnapshotDiffV1>;
```

已接受 RFC 可以微调命名，但不得改变以下不变量：

- 结果深度不可变、可 JSON 序列化、排序确定，不包含可变 `Map`/`Set` 或内部编译器实例。
- Invalid Snapshot 返回带 Diagnostic 的 `status: "incomplete"`，不能错误报告“没有变化”。
- 每项变化具有稳定身份、可用时同时包含 before/after source anchor，并携带精确 Context coverage。
- 直接值变化与仅由依赖传播产生的变化必须区分。
- 结构分类至少包含 add、remove、type、metadata、dependency、Context coverage 与建议性 rename candidate。
- Backend comparison 只调用 `prepare()`；比较已分配 symbol 与计划 artifact identity/path，不执行 emit。
- `SnapshotDiffV1` 与 CLI impact JSON envelope 作为显式 JSON Schema subpath export 发布，并加入公共
  contract hash 门禁。

## 5. 命令契约

目标 CLI 表面为：

```bash
tokenc impact tokens/brand.json --context theme=dark --format json
tokenc diff --base main --head worktree --format text
tokenc diff --base origin/main --head HEAD --format json
tokenc diff --base main --head worktree --policy tokenc.policy.json --format sarif
tokenc check --format sarif
```

规则：

- `--head` 默认 `worktree`；`diff` 必须提供 `--base`。
- 可重复的 `--context name=value` 是 M2 命令统一的 Context 语法。
- `--format text|json|sarif` 是共享 report switch；与该语法冲突的 command-specific 旧参数直接替换。
- Core 不启动子进程。CLI Git provider 只读 repository object，不 checkout 或修改用户分支。
- Source revision 获取与语义比较是两个独立阶段，拥有独立 Diagnostic。
- 退出码 `0` 表示编译与 policy 均通过，`1` 表示 compiler/policy finding，`2` 表示无法完成比较；RFC
  必须在实现前锁定精确映射。

## 6. 范围

M2 包含：

- Snapshot Diff v1、Impact Report v1 契约及 JSON Schema。
- Context-aware 的结构、resolved value、dependency、impact、Backend symbol 与 artifact diff。
- `tokenc impact`、`tokenc diff`，以及 `check`/`diff` 的 SARIF 输出。
- 带文档化默认值与 override 的确定性 breaking-change policy。
- Resolver permutation 的惰性规划、过滤、有界枚举与比较。
- CLI 中不修改分支的 Git revision/worktree source provider。
- GitHub Actions 与 vendor-neutral CI 示例。
- Terrazzo 共存指南，以及只接收已 bundle 标准 DTCG 的非发布实验 adapter 示例。

M2 不包含：

- Language Server、编辑器扩展、rename 操作或 code-action transport；这些属于 M3。
- 持久化 build cache、通用 Importer SDK、新生产 Backend 或 transform pipeline。
- Core 内的网络访问、Git 操作、SARIF 渲染或 policy 决策。
- 直接执行不可信 base/head revision 中的配置代码。
- 达到比较上限后猜测完整 Context coverage。
- 重现 Terrazzo transform 或任意第三方插件副作用。

## 7. 交付顺序

### Gate 0：先冻结契约与证据，再扩展 CLI

#### M2-00 — 变更智能 RFC 与 fixture 基线（P0，已完成）

已接受证据：[RFC 0004](rfcs/0004-change-intelligence.zh-CN.md)、
[`change-intelligence` fixture matrix](../benchmarks/fixtures/change-intelligence/matrix.v1.json)、
未公开的 [Schema 草案](schemas/drafts/)与 [M2-00 benchmark 基线](M2-00-BASELINE.zh-CN.md)。

交付：

- 新增一份聚焦 RFC，覆盖 Snapshot comparison model、change taxonomy、identity/sorting、双 revision
  impact、incomplete result、trusted-config boundary、policy 分层、report format、exit code 与拒绝方案。
- 增加受版本控制的 before/after fixture matrix，覆盖 add/remove、明确与歧义 rename、直接/传播值变化、
  type/metadata/dependency 变化、互斥 Context、invalid base/head、Backend symbol/path 变化和 config 变化。
- 增加一个现实分层 fixture，包含 primitive、semantic alias、component、多 Context 维度和至少 1,000 个
  Token，并记录精确 direct/transitive impact 期望。
- 记录 M2 前基线：Snapshot 构造、impact traversal、Backend preparation、report size 与峰值内存；缺少
  同环境证据前，wall time 仍只作为建议性指标。

验收：

- 路线图中的每个变化类别都映射到明确 fixture 与拟议 v1 字段。
- RFC 证明为何完整 impact 必须同时遍历 old/new Graph。
- RFC 锁定 config 变化的安全行为，不会静默执行历史配置。
- Fixture expectation 是可审查数据，不是在同一次运行中生成并自行接受的 snapshot。
- Gate 0 接受前不增加生产命令或公共类型。

#### M2-01 — Snapshot Diff v1 Core 垂直切片（P0，已完成）

已接受证据：公开的 [`compareSnapshots()` 实现](../packages/core/src/snapshot-diff.ts)、已导出的
[`snapshot-diff-v1.schema.json`](../packages/core/schema/snapshot-diff-v1.schema.json)与聚焦的
[differential test](../packages/core/test/snapshot-diff.test.ts)。实现只使用不可变 Snapshot、Query、
Predicate 与 Backend preparation 边界。

交付：

- 实现两个内存 Snapshot、一个显式 Context 的 `compareSnapshots()`。
- 分类 add/remove、直接值、传播值、type、metadata、dependency 与 Context coverage 变化。
- 同时遍历 base/head 条件 Graph，产生完整 direct/indirect impact。
- Invalid Snapshot 或未覆盖比较区域返回 incomplete result。
- 增加确定性 JSON 序列化与 `snapshot-diff-v1.schema.json`。

验收：

- 交换 base/head 时，存在逆操作的事实得到预期逆结果。
- 相同 Snapshot 得到字节稳定的空 diff。
- 互斥 Predicate 不产生传播假阳性。
- 删除依赖时仍报告只能从 base Graph 到达的 dependent。
- Schema conformance 与公共 declaration snapshot 通过。

### Wave 1：用户可消费的变更事实

#### M2-02 — Source-to-Token impact 命令（P0，已完成）

已接受证据：公开的 [`buildImpactReport()` 实现](../packages/core/src/impact-report.ts)、已导出的
[`impact-report-v1.schema.json`](../packages/core/schema/impact-report-v1.schema.json)、不访问 Git 的
`tokenc impact` 命令，以及聚焦的 [Core](../packages/core/test/impact-report.test.ts) 与
[CLI](../packages/cli/test/cli.test.ts) 测试。Snapshot document 现在保留其拥有的 canonical Token ID，
包括 inheritance 物化出的 Token。

交付：

- 使用 Snapshot source fact 把变化文档路径映射为 Token ID；存在可选 base Snapshot 时包含 removed Token。
- 增加带 text 与版本化 JSON 输出的 `tokenc impact <path...>`。
- 支持可重复 Context filter；未指定 Context 时保留 Predicate 区域。
- 区分 directly changed、directly affected 与 transitively affected Token。

验收：

- Alias、JSON Pointer component、inheritance 和 Context override 变化都得到完整 impact。
- 未知路径与不含 Token 的路径是显式、确定的结果。
- CLI 输出归一化后与公共 Core 结果一致。

#### M2-03 — Git revision provider 与 `tokenc diff` 垂直切片（P0，已完成）

已接受证据：CLI-owned
[`GitRevisionProvider`](../packages/cli/src/git-revision-provider.ts)、通过公共 `compareSnapshots()`
边界实现的 `tokenc diff`，以及使用[临时仓库的 integration test](../packages/cli/test/git-diff.test.ts)。测试
证明 branch、HEAD、index、worktree、staged、unstaged、untracked、rename、add 与 delete 状态执行前后完全
一致；同时覆盖缺失/浅历史 revision、删除 Resolver source、非法 Snapshot、configuration trust，并验证
JSON 不受 checkout 路径影响。

交付：

- 增加 CLI-owned、只读的 Git ref 与当前 worktree provider。
- 使用一份可信 analysis config 编译 base/head，不 checkout 任一 revision。
- 增加 `tokenc diff --base <ref> [--head <ref|worktree>]` 的 text/JSON 输出。
- 检测 config 文件变化；除非显式选择共同可信 config，否则返回 incomplete comparison Diagnostic。
- Head view 保留 committed、staged、unstaged、added 与 deleted worktree 文件。

验收：

- Integration test 使用临时 Git repository，并证明用户 branch、index 与文件均未改变。
- Missing ref、shallow history、renamed file、deleted Resolver source 与 invalid Snapshot 都确定性失败。
- 相同两棵 source tree 不受 checkout path 影响，产生字节一致的 JSON。

#### M2-04 — Breaking-change policy（P0，已完成）

实现由 [`breaking-policy.ts`](../packages/core/src/breaking-policy.ts)、已发布的
[`breaking-policy-v1.schema.json`](../packages/core/schema/breaking-policy-v1.schema.json) 与
`tokenc diff --policy <path>` 组成。Evaluator 保留原始输入 diff，保留已 allow 的 finding 供审计，且
invalid/incomplete 判断的退出码优先于 policy failure。M2-05 将把同一 evaluation model 投影为 SARIF。

交付：

- 定义小型版本化 policy schema，包含 rule severity、allow entry 与 Context scope。
- 为 Token removal、type change、Context coverage 丢失、Backend symbol/path removal、直接值变化与传播值
  变化提供文档化默认值。
- Policy 只消费 `SnapshotDiffV1`，不得在 policy 层重新计算语义差异。
- 输出稳定 Diagnostic v1 finding 和确定性进程退出行为。

验收：

- Policy 配置只改变 severity，不改变底层 diff。
- Allow entry 必须引用稳定 change identity，且不能抑制 compiler error。
- 未知 rule、过期 allow entry 与 incomplete comparison 默认安全失败。
- Text、JSON 与 SARIF 报告相同 finding identity 与 severity。

### Wave 2：完整报告与 Context 覆盖

#### M2-05 — 共享 Text、JSON 与 SARIF Reporter（P0，已完成）

实现由不可变 [`ReportV1`](../packages/cli/src/report.ts) projection 与公开
[`report-v1.schema.json`](../packages/cli/schema/report-v1.schema.json) 组成。`check` 与 `diff` 现在从同一组
规范化 entry 渲染 text、JSON 或 SARIF 2.1.0。SARIF 保留 rule metadata、location、related location、
已校验 fix、policy suppression 与 Diagnostic fingerprint；路径相对仓库根目录，外部临时路径前缀会被移除。

交付：

- 引入一份由所有 renderer 消费的不可变 report model。
- 为 `check` 与 `diff` 增加 `--format text|json|sarif`；`impact` 在没有 source-located policy finding 时
  只提供 text/JSON。
- 输出 SARIF 2.1.0：包括 rule metadata、artifact URI、region、related location、合法 fix，以及
  `partialFingerprints` 中的 Diagnostic fingerprint。
- 相对显式 repository root 规范化路径，并移除临时 materialization path。

验收：

- JSON 通过仓库 Schema，重复执行时字节一致。
- SARIF 通过独立 SARIF 2.1.0 validator 与 golden test。
- 每个 source-backed Diagnostic 在 text/JSON/SARIF 中保持相同 file、line、column、severity、rule 与
  fingerprint。
- Renderer 不执行 compilation、Graph traversal 或 policy evaluation。

#### M2-06 — Resolver permutation 惰性规划与比较（P0，已完成）

实现由不可变、可迭代的
[`ResolverPermutationPlanV1`](../packages/core/src/permutation.ts) 以及公开
`planResolverPermutations()`、`compileResolverPermutations()` 和
`compareResolverPermutations()` API 组成。Planning 在枚举前校验精确 filter 和显式 limit；执行时让每一侧
串行复用持久 `CompilerSession`，通过 Snapshot Diff v1 比较，并在可选 emit 前对整个批次的 Backend artifact
path 做完整 preflight。

交付：

- 增加公共不可变 permutation plan，包含 dimensions、estimated count、validation Diagnostic 与惰性有界
  iterator。
- 支持精确 Context filter；多 permutation 枚举必须指定 limit。
- 所有 permutation 通过同一个 `CompilerSession` 编译，复用未变化的 Parse/Link 工作；Graph 与 Resolve
  cache 只在 Context facts 仍有效时复用，否则报告明确的 `context-changed` invalidation。
- 通过同一个 `compareSnapshots()` API 比较选中的 base/head permutation。
- 在任何可选批量 emit 前，对所有选中 Backend plan 与 artifact path 做整体 preflight。

验收：

- Planning 不物化笛卡尔积。
- Invalid input、未知 filter、limit exhaustion 与 output collision 都产生显式 Diagnostic。
- 每个已访问 permutation 的结果与独立 cold compilation 一致。
- Cache counter 证明 source/link 复用；多次运行排序稳定。

### Wave 3：CI 落地与互操作

#### M2-07 — CI 配方与 GitHub Actions 参考工作流（P0，已完成）

实现由双语 [`CI.md`](CI.zh-CN.md) 指南、固定 commit 的
[`tokenc.yml`](../.github/workflows/tokenc.yml) 参考 workflow，以及可执行
[`ci-repository`](../packages/cli/test/fixtures/ci-repository) Git fixture 组成。workflow 将 text、JSON、
SARIF 保留 14 天，只在具有 code-scanning 写权限时上传 SARIF；只读 fork Pull Request 仍会生成并上传可下载
报告。

交付：

- 文档化通用 CI 命令、退出码、artifact retention、baseline selection 与 shallow-clone 要求。
- 增加固定 action commit 的 GitHub Actions 示例，生成 JSON/SARIF、上传 SARIF 并保留可读报告。
- Fork Pull Request 不需要 write token 或 npm credential。
- 说明其他工具继续负责生成时，如何把 tokenc 作为独立 checking layer。

验收：

- Fixture repository 覆盖通过、breaking failure、compiler failure 与 incomplete comparison。
- 示例使用最小权限，release path 不包含未固定版本的 action。
- 本地与 CI 命令产生相同 report fingerprint。

#### M2-08 — Terrazzo 共存指南与实验 Adapter（P1，已完成）

实现由双语 [`TERRAZZO.md`](TERRAZZO.zh-CN.md) 指南与私有
[`terrazzo-adapter`](../examples/terrazzo-adapter) workspace 组成。Adapter 通过内存中的公开
`DocumentLoader` 接收一份已经 bundle 的标准 DTCG JSON 文档，通过全新的公开 `CompilerSession` 编译，
并在不导入 Terrazzo、不重新实现其 transform 的前提下分类 extension namespace。

交付：

- 增加 tokenc check/diff/impact 与现有 Terrazzo 生成流水线并行运行的指南。
- 增加非发布示例 Adapter，只接收已经 bundle 的标准 DTCG，并通过公共 `DocumentLoader`/Session 边界
  输入 tokenc。
- 对不支持的 extension data 分类，但不导入或模拟 Terrazzo transform。

验收：

- Adapter failure 不能修改 Snapshot 或改变 Core 语义。
- Adapter 不 deep import Core，Core 内不执行网络请求。
- 指南明确列出已表示与未表示的 Terrazzo 行为。

#### M2-09 — Differential proof、性能门槛与 `0.5.0` release candidate（P0，已完成）

交付：

- 使用独立归一化 reference model，对 deterministic 与 seeded change sequence 执行 M2 engine
  differential comparison。
- 为单文件 diff、high-fan-out impact 与 bounded permutation comparison 增加稳定语义工作量预算；跨机器
  latency 仍为建议值。
- 将 declaration 与 M2 JSON Schema 加入公共 contract manifest。
- 发布最终双语 command、schema、policy、CI、安全与 migration 文档。
- 增加 Changeset，运行 package dry-run、packed consumer smoke 与隔离 clean-worktree 门禁。

验收：

- 下方每项 M2 退出条件都有自动化证据，且 M1 无未解释回归。
- Structural fact、resolved scope、impact、Backend plan、policy finding、JSON 与 SARIF normalized location
  的 differential mismatch 全部为零。
- 公共 declaration 与 machine schema 只能通过有意 contract update 修改。
- Release candidate 通过 `vp run verify`、package dry-run、packed smoke 与 clean-worktree 验证。
- 获得授权并发布后，registry-installed smoke、provenance、dist-tag 与 annotated-tag 验证全部通过，才能
  标记 M2 关闭。

## 8. 依赖与关键路径

```text
M1 publication ────────────────────────────────────────────────────────┐
                                                                       ▼
M2-00 RFC/baseline → M2-01 Snapshot Diff → M2-03 Git diff → M2-04 policy
                              │                │               │
                              └→ M2-02 impact ─┘               ▼
                                                       M2-05 reporters
                                                              │
M2-01 Snapshot Diff → M2-06 permutations ─────────────────────┤
                                                              ▼
                                                       M2-07 CI recipes
                                                              │
                                                       M2-08 coexistence
                                                              │
                                                              ▼
                                                       M2-09 release gate
```

- M2-00 立即开始；M1 发布可以并行，但它是公开 M2 release work 的前置 Gate。
- M2-01 完成后，M2-02 可与构建 Git provider 的 M2-03 并行。
- M2-04 依赖稳定 diff identity；M2-05 同时依赖 diff 与 policy fact。
- M2-06 复用 M2-01，可在 Core 垂直切片后与 policy/reporting 并行。
- M2-07 与 M2-08 只消费稳定命令，不定义替代语义。

## 9. 推荐实现切片

| 顺序 | 切片               | 主要产物                                         | 合并门禁                                    |
| ---- | ------------------ | ------------------------------------------------ | ------------------------------------------- |
| 1    | 契约与 fixture     | RFC、taxonomy、fixture matrix、baseline          | 每项路线图类别都有明确证据                  |
| 2    | Core diff 垂直切片 | `SnapshotDiffV1`、单 Context、JSON Schema        | inverse/empty/Context differential test     |
| 3    | Impact CLI         | source-to-Token mapping、text/JSON               | Core/CLI parity 与全部 edge kind 覆盖       |
| 4    | Git diff CLI       | base/head provider、worktree overlay             | 临时 repository 非修改性测试                |
| 5    | Policy             | 默认值、override、稳定 finding                   | fail-closed policy matrix                   |
| 6    | Reporter           | 共享 report IR、text/JSON/SARIF                  | Schema、SARIF 与跨格式 identity 测试        |
| 7    | Permutation        | 惰性 plan、filter、有界比较                      | cold-build differential 与 allocation bound |
| 8    | CI 落地            | 通用指南与 GitHub 参考 workflow                  | 最小权限端到端 fixture                      |
| 9    | Terrazzo 共存      | 指南与只使用公共边界的 Adapter 示例              | 隔离与 unsupported-behavior 测试            |
| 10   | Release gate       | contract、性能预算、Changeset、packed validation | M2 所有退出条件通过                         |

每个切片必须同时包含实现、测试、中英文文档；改变公共行为时还必须包含 Changeset。一个切片最多引入一层新的
公共契约。

## 10. M2 验收矩阵

| 官方退出条件                                      | 必须提供的自动化证据                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 报告区分直接、传播与 Context-specific impact      | old/new Graph differential fixture、互斥 Context 测试与精确 source/Predicate 断言     |
| SARIF 在 GitHub-compatible 结果中指向准确源码位置 | SARIF 2.1.0 validation，以及 text/JSON/SARIF identity/location parity                 |
| Diff 输出版本化且确定                             | JSON Schema conformance、golden fixture、重复执行字节一致与公共 contract hash         |
| 一个现实中大型 fixture 完整验证 impact traversal  | checked-in expected changed/direct/indirect 集合与完整 traversal comparison           |
| Adapter failure 不改变 Core 语义                  | public-import boundary、不可变 Snapshot、loader failure 与 unsupported-extension 测试 |

额外 release candidate 门禁：

- Git comparison 不修改 checkout、index、branch 或 repository configuration。
- Invalid 或 incomplete comparison 永远不能报告 policy pass。
- Resolver enumeration 必须惰性、有界、确定，并与 cold build 等价。
- 所有 report format 携带相同 finding identity 与 policy verdict。
- M1 test、公共 contract、packed consumer smoke 与性能门槛继续通过。

## 11. 立即执行的下一步

M2 实现已完成。保持 release candidate 不变，直到获得授权的操作人发布精确的五包 manifest，并完成
registry、provenance、dist-tag 与 annotated-tag 验证；证据记录见
[M2 验收记录](M2-ACCEPTANCE.zh-CN.md)。

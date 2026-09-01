# tokenc 产品战略与发展路线图

[English](ROADMAP.md) | [简体中文](ROADMAP.zh-CN.md)

> 状态：方向性规划，不是版本承诺。更新时间：2026-08-31。

本文定义 tokenc 在未来几个里程碑中的产品定位、架构演进、交付顺序与验收标准。它补充
[架构文档](ARCHITECTURE.zh-CN.md)和
[DTCG 支持矩阵](DTCG-SUPPORT.zh-CN.md)：架构文档描述系统现在如何工作，支持矩阵描述现在实现了什么，
本文则解释接下来为什么做、先做什么，以及怎样判断已经完成。

## 执行摘要

tokenc 不应发展成一个更小的 Terrazzo，也不应以 Backend 数量或 Importer 数量作为主要竞争指标。
项目应聚焦于以下定位：

> **面向大型 Design System 的 DTCG 语义编译器：严格、可解释、增量，并可嵌入 IDE、CI 和构建系统。**

Terrazzo 已经提供成熟的插件生命周期、格式转换、Resolver permutations、Figma 导入和多平台输出。
tokenc 当前更有价值的基础是 typed frontend、source provenance、显式 dependency graph、惰性 Context
求值、结构化诊断与增量失效。路线图应把这些基础转化成用户可感知的能力：

1. 证明 Token 在所有有效 Context 下是正确的。
2. 精确解释一个值来自哪里、为什么变化、会影响什么。
3. 编辑后只重算真正受影响的语义区域。
4. 通过稳定 API 让编辑器、CI 和其他工具复用同一个编译器事实源。
5. 与现有 DTCG/Terrazzo 工作流共存，降低采用成本。

前两个里程碑必须优先修复已知正确性缺口，之后才扩大生态表面积。一个输出格式很多、但可能静默生成
冲突符号或无效 composite 值的编译器，不具备可信的差异化。

## 1. 市场位置与边界

### 1.1 与 Terrazzo 的分工

| 维度       | Terrazzo 的优势               | tokenc 的目标优势                   |
| ---------- | ----------------------------- | ----------------------------------- |
| 产品形态   | 完整 Token 工具平台           | 可嵌入的语义编译器内核              |
| 输入与导入 | YAML、远程引用、Figma、bundle | 严格 DTCG、可追踪 provenance        |
| 扩展方式   | 灵活的 plugin transforms      | 类型安全、分阶段、可缓存的扩展契约  |
| 输出生态   | 多平台插件成熟                | 少量 reference-quality Backend      |
| 依赖分析   | Alias metadata                | 条件依赖图、反向查询、影响分析      |
| 增量模型   | watch 后完整 parse/build      | 文件与 Token/Context 级增量 Session |
| 错误呈现   | Logger 和 lint                | 稳定代码、关联位置、trace、修复建议 |
| 开发体验   | CLI 工作流完整                | IDE、CI、构建工具共享语义 API       |

差异化不等于拒绝互操作。近期最现实的采用路径是让团队保留现有生成链路，同时使用 tokenc 执行严格
检查、IDE 分析和 Pull Request 影响报告。只有当 Backend 达到 reference-quality 时，才建议用户迁移
对应输出。

### 1.2 目标用户

优先服务：

- 拥有多主题、多品牌、多平台或多密度配置的大型 Design System 团队。
- 需要在 Monorepo 中判断 Token 变更影响范围的基础设施团队。
- 需要 Token 补全、跳转、重命名和实时诊断的编辑器/IDE 开发者。
- 希望把 DTCG 编译能力嵌入内部设计平台、CI 或构建系统的工具作者。
- 对可重复构建、审计线索和破坏性变更控制有要求的企业团队。

近期不是重点：

- 只需要一次性 JSON 转 CSS 的极小项目。
- 依赖大量非标准 transform 且不要求确定性或类型安全的流水线。
- 通用设计资产管理、可视化编辑器或 Figma 替代品。

### 1.3 产品承诺

tokenc 的公开能力应该围绕四个承诺组织：

- **Correct**：相同输入总是得到相同结果；不静默丢失信息或生成冲突输出。
- **Explainable**：每个诊断和值都可以回溯到来源、Context 和依赖路径。
- **Incremental**：编辑成本与受影响子图相关，而不是与整个仓库规模直接相关。
- **Embeddable**：CLI、Language Server 和 CI 只是同一公共 API 的不同客户端。

## 2. 产品原则与非目标

### 2.1 必须保持的原则

1. **DTCG 是唯一 Core 源语言。** 外部格式由 Importer 转换成 DTCG，不能绕过 Frontend 直接构造
   `TokenNode`。
2. **Compiler IR 是 Backend 的唯一输入。** Backend 不重新 parse、merge 或修改语义节点。
3. **结构化结果优先。** Core 不打印、不退出进程、不直接写文件。
4. **Canonical identity 与平台名称分离。** Token ID、Backend symbol 和 serialized name 是三个概念。
5. **扩展必须声明阶段和能力。** 只读 lint、Importer、Resolver provider 和 Backend 使用不同契约。
6. **正确性优先于宽松兼容。** 兼容行为必须显式、可诊断、可配置，不能靠隐式 deep merge。
7. **性能声明必须有基准。** 在同 fixture、同环境的测量完成前，不宣称比其他工具更快。

### 2.2 当前不做

- 不复制通用的任意 object transform pipeline。
- 不在 Core 中加入 Figma API、网络请求或文件写入。
- 不为了 Backend 数量牺牲 composite 语义和输出有效性。
- 不物化所有 Context 的完整笛卡尔积。
- 不在稳定 API 之前开发独立 GUI。
- 不把 `org.token-compiler.contexts` 描述为 DTCG 标准能力。

## 3. 目标系统架构

```text
Foreign / legacy sources
        │
        ▼
Importer SDK ──────────────→ Valid DTCG documents
                                  │
                                  ▼
                         Frontend + provenance
                                  │
                                  ▼
                        Typed semantic model
                                  │
                                  ▼
                    Conditional dependency graph
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
          Checker / lint    Incremental session   Query engine
                 │                │          explain / usages / impact
                 └────────────────┼────────────────┘
                                  ▼
                         Immutable Compilation IR
                                  │
                 ┌────────────────┼────────────────┐
                 ▼                ▼                ▼
          Backend SDK       Language Server      CI reporters
                 │                                  │
                 ▼                                  ▼
       CSS / TS / platform files             JSON / SARIF / PR
```

建议最终拆分为以下公共边界；是否立刻拆 package，应由 API 稳定度决定，而不是先做目录重构：

| 边界                      | 职责                                                  |
| ------------------------- | ----------------------------------------------------- |
| `@tokenc/core`            | DTCG Frontend、语义模型、Graph、Checker、Resolver、IR |
| `@tokenc/session`         | 长生命周期增量编译、缓存、文件更新与查询快照          |
| `@tokenc/language-server` | LSP 协议适配，不复制编译逻辑                          |
| `@tokenc/ci`              | diff、impact、SARIF/JSON 报告和变更策略               |
| `@tokenc/backend-*`       | 只读 IR 到平台产物                                    |
| `@tokenc/importer-*`      | 外部格式到带 provenance 的 DTCG                       |

在 Session API 稳定前，可以先把实现放在 Core 内部；不要为了路线图中的名字制造过早 package。

## 4. 核心技术工作流

### 4.1 条件依赖图

当前依赖边合并了所有 Context override，可能把不同 Context 下互斥的引用误判为循环。Graph 应从
`from → to` 升级为携带语义的 edge：

```ts
interface DependencyEdge {
  readonly from: TokenId;
  readonly to: TokenId;
  readonly kind: "alias" | "json-pointer" | "inheritance" | "composite-field";
  readonly condition: ContextPredicate;
  readonly source: SourceLocation;
}
```

必须同时调整：

- Cycle detection：在可满足的 Context 投影上判断环，并返回触发条件。
- Topological order：为无条件公共顺序提供稳定结果，对条件分支使用求值期 trace。
- Reverse usages：返回依赖方以及使该边生效的条件。
- Impact analysis：区分全局受影响与特定 Context 受影响。
- Incremental invalidation：条件变化只失效相关 `(TokenId, Context)` 缓存。
- Diagnostics：循环路径中每条边包含 source range 和 Context predicate。

验收 fixture 至少覆盖互斥 override、部分重叠 predicate、多维 Context、base/override 混合环和真正的
条件环。

### 4.2 名称与符号分配

所有 Backend 在 emit 前执行显式 name allocation：

```text
Canonical TokenId
  → Backend naming policy
  → allocated symbol table
  → collision diagnostics
  → serialization
```

公共能力应包括：

- Backend 声明目标命名空间是否大小写敏感。
- 检测 `foo-bar` / `foo.bar`、保留字、非法首字符和 Unicode normalization 冲突。
- Diagnostic 同时指向两个冲突 Token。
- 可选的显式 rename map；默认不得自动追加不稳定序号。
- CSS custom property、Tailwind namespace、TypeScript binding 分别建立符号表。
- symbol table 可供 `explain`、source map 和 Language Server 查询。

### 4.3 类型和值序列化

Core 应保存标准化但不丢失 DTCG 语义的值；Backend 必须显式声明它支持哪些 Token 类型和引用策略。

建议增加 capability negotiation：

```ts
interface BackendCapabilities {
  readonly tokenTypes: ReadonlySet<TokenType>;
  readonly references: ReadonlySet<"preserve" | "symbol" | "resolve">;
  readonly contexts: "none" | "selectors" | "files";
}
```

当 Backend 无法表示某种 composite 或颜色空间时，应返回诊断，而不是 `JSON.stringify` 或静默降级。
CSS Backend 作为 reference implementation，优先补齐 border、shadow、gradient、transition、typography
等类型的合法序列化与多值规则。无法无损表示的 DTCG 值需要明确的 policy 和文档。

### 4.4 Compiler Session

目标公共接口：

```ts
const session = await createCompilerSession(config);

await session.update({ source: "tokens/color.json", content });

const snapshot = session.snapshot();
snapshot.diagnostics;
snapshot.analyzeImpact(changedIds);
snapshot.explain(tokenId, context);
await snapshot.emitAffected([cssBackend]);
```

Session 需要定义：

- snapshot 的不可变性和并发读取规则。
- 文件新增、修改、删除、无效后恢复的统一事务语义。
- Parser、Linker、Graph、Resolver 和 Backend cache 的 ownership。
- Resolver 文档变更和普通 Token 文档变更的不同失效边界。
- 配置变化、Backend options 变化和编译器版本变化的 cache key。
- 失败构建是否可以保留上一个成功 snapshot；默认输出不得混合两个 snapshot。
- 可选持久化缓存格式、版本和失效策略。

第一阶段只要求进程内缓存。持久化缓存必须在 cache correctness fixture 和 deterministic build 验证后启用。

### 4.5 Resolver permutations

当前“一次编译选择一个 Resolver input”保持为简单 API，同时新增枚举和批量分析能力：

```ts
const plan = await compiler.planResolverInputs();
for (const permutation of plan.validPermutations()) {
  await session.compilePermutation(permutation);
}
```

要求：

- 支持显式列举，不默认物化笛卡尔积。
- 调用者可以提供 filter 或 iterator 上限。
- 共享未变化 Source、Linker 和 Token 子图缓存。
- 输出路径碰撞在写入前整体检查。
- 能比较两个 permutation 的 semantic diff。
- 远程 Resolver 引用由可注入 loader 提供，Core 本身不执行网络 IO。

### 4.6 Diagnostics 与 lint policy

区分 compiler error 与组织 policy：

| 层级                     | 示例                                       | 是否可关闭          |
| ------------------------ | ------------------------------------------ | ------------------- |
| Syntax/semantic error    | 无效类型、未知引用、可满足的循环           | 否                  |
| Backend capability error | 目标平台无法表示值、名称碰撞               | 选择该 Backend 时否 |
| Lint policy              | 命名约定、缺少 description、禁止 raw color | 是                  |

Lint Rule 只读 semantic snapshot，并返回普通 `Diagnostic[]`。规则不能修改 Token、改变 resolution order
或依赖终端输出。Diagnostic schema 后续应支持 rule id、documentation URL、fix edit、suppression reason 和
stable fingerprint，以便 IDE、SARIF 和增量去重共用。

### 4.7 Query、diff 与 CI

现有 `explain`、`usages` 和 `graph` 应建立在一个公共 Query API 上，而不是继续只增加 CLI 分支。

目标命令：

```bash
tokenc explain color.action.primary --context theme=dark
tokenc usages color.brand --context theme=light
tokenc impact tokens/brand.json --format json
tokenc diff --base main --head HEAD
tokenc check --format sarif
```

Semantic diff 至少区分：

- Token 新增、删除、重命名候选。
- 直接值变化和仅由依赖传播产生的变化。
- 类型、metadata、Context coverage 和最终 resolved value 变化。
- 受影响的 Backend symbol 和 output file。
- 潜在 breaking change 与非破坏性变化。

Git 集成属于 CLI/CI 层；Core 接受两个 snapshot，不直接运行 Git 命令。

### 4.8 Language Server

Language Server 必须消费 Compiler Session，而不是维护第二套 Parser。第一版范围：

- publish diagnostics。
- Alias completion。
- go-to-definition 和 find-references。
- hover 展示 type、source expression、resolved value 和有效 Context。
- document symbol 与 workspace symbol。
- rename 前检查 canonical ID 和 Backend symbol 冲突。
- code action 应用结构化 fix。

第二版再考虑 Context 切换 UI、内联色块、依赖图 Webview 和 semantic diff。VS Code extension 应保持薄，
避免把能力绑定到单一编辑器。

### 4.9 互操作层

tokenc 应优先兼容标准 DTCG 项目，并允许外部工具提供文档：

- 接受 `$schema`，保留但不把它解释为 Token group property。
- 提供 `DocumentLoader` 接口支持虚拟、远程或工具生成的文档。
- 对未知 `$extensions` 默认保留；只有注册 Interpreter 后才赋予语义。
- 用兼容性报告区分“标准错误”“未知扩展”和“尚未实现”。
- 可选 Terrazzo adapter 读取其已解析/已 bundle 输入，或把项目源转换为标准 DTCG 后交给 tokenc。

Terrazzo adapter 不能把 Terrazzo transform pipeline 引入 Core，也不承诺重现任意第三方插件的副作用。
它的目标是让现有团队采用 tokenc 的 check、LSP 和 impact，而不是强制替换生成链路。

## 5. 分阶段路线图

版本号只在发布计划确定后映射；下面使用带退出条件的里程碑，避免把日期当作完成度。

### M0 — 建立可信基线

**目标：** 消除会静默产生错误结果或阻断常见 DTCG 输入的问题。

**状态（2026-08-25）：已完成。** 五项退出条件全部通过，五个公开包已经以 `0.3.0` 发布，并带有 npm
provenance 和 annotated package tags。`tokenc check` Backend 预检、输出路径碰撞保护、CSS/Tailwind
多维 Context 覆盖不完整时的显式失败，以及固定且分类的生态兼容性基线均已进入发布版本。验收证据与发布
治理后续项记录在 [M0 验收记录](M0-ACCEPTANCE.zh-CN.md)中。

交付物：

- 修复所有 Backend 的名称碰撞，并加入跨 Backend fixture。
- 实现 Context-aware cycle detection，消除互斥 Context 假环，并对每个候选区域设置确定性的 16,384
  次投影上限。
- 正确接受根级 `$schema`。
- CSS/Tailwind 对支持的 composite 生成合法值；不支持时明确报错。
- 修复顶层 Tailwind namespace 的空段命名。
- 统一 package 版本、Core `VERSION`、发布文档和生成物目录策略。
- CI 增加 clean checkout 检查，禁止 `.d.ts`/`.d.ts.map` 泄漏到 `src`。
- 接入固定版本的 DTCG 生态 examples；失败按 unsupported、extension、bug 分类，不只统计通过率。

退出条件：

- 已知 collision 和 conditional-cycle fixture 全部通过。
- Backend 不再静默输出不可消费的 composite JSON。
- clean checkout 上 `check`、build、test 全部通过且工作区保持干净。
- 支持矩阵与实现一致，每个未支持项具有稳定诊断。
- 发布一个包含这些修复的版本并完成 migration notes。

### M1 — 稳定语义编译器 API

**目标：** 把差异化从内部实现转成可靠的公共接口。

**状态（2026-08-31）：实现完成，0.4.0 release candidate。** 有序任务、依赖关系和自动化验收矩阵见
[M1 执行计划](M1-PLAN.zh-CN.md)；本地候选版本已由 [M1 验收记录](M1-ACCEPTANCE.zh-CN.md)
确认通过。发布及发布后 registry 验证完成后，里程碑正式关闭。

交付物：

- 条件依赖边和带 Context 的 Graph Query API。
- 公共 symbol allocation 与 Backend capability API。
- 稳定的 `explain` trace schema。
- `CompilationSnapshot` 和进程内 `CompilerSession`。
- Parser/Linker/Resolver/Graph 阶段的 cache metrics。
- Diagnostic schema v1，包括 fingerprint、related locations 和 optional fix。
- API stability 文档与直接破坏式替代策略。

退出条件：

- 单文件编辑不会重新解析未变化文件。
- 失效集合与全量重编译结果通过 differential tests 保持一致。
- 同一 snapshot 的并发只读查询结果确定。
- Backend 可在 emit 前完整发现 symbol、值表达、capability 与 output-path 错误。
- CLI 与内置 Backend 已迁移到公共 Session、Query、IR 和 planning API，没有私有旁路。

### M2 — CI 与变更智能

**目标：** 让 tokenc 首先作为现有 Token 流水线的安全检查层被采用。

**状态（2026-09-01）：已完成；`0.5.0` 已通过 `next` dist-tag 发布，M2 已关闭。** 变更智能契约、证据基线、
公开 Snapshot Diff v1 与 Impact Report v1 API、JSON Schema、`tokenc impact` 和只读 Git-backed
`tokenc diff`、Breaking-change Policy v1、共享 Report v1 text/JSON/SARIF renderer，以及 Resolver
permutation 惰性规划、Session 编译、Snapshot Diff 比较与 Backend 批量 preflight，以及固定 commit 的 CI
参考 workflow、fork-safe artifact 路径与四结果可执行 fixture，以及有界、仅使用公开 API 的 Terrazzo
handoff 与显式 unsupported-extension 分类、独立 differential proof、语义工作量门禁、公共契约锁和
packed release 证据均已完成。获得授权的 release workflow 已通过 registry、provenance、dist-tag 与
annotated-tag 验证；详见
[M2 验收记录](M2-ACCEPTANCE.zh-CN.md)。

交付物：

- `tokenc diff` 与 `tokenc impact`。
- JSON、SARIF 和可读文本三种稳定输出。
- breaking-change policy 配置。
- Resolver permutation 枚举、过滤和 semantic comparison。
- GitHub Actions 示例与通用 CI 文档。
- Terrazzo 共存指南和实验性 adapter。

退出条件：

- PR 报告能区分直接变化、传递影响与 Context-specific 影响。
- SARIF 在 GitHub code scanning 中准确定位到源码。
- diff 输出具有 snapshot tests 和 schema version。
- 至少一个真实中大型 fixture 验证无漏报的 impact traversal。
- adapter 失败不会改变 Core 语义，未知扩展被清晰分类。

### M3 — IDE-first 开发体验

**目标：** 把编译器事实源带入编辑循环。

**状态（2026-09-02）：M3-03 server lifecycle 已完成；下一步为 M3-04。** 公开且 transport-neutral 的
`EditorSymbolV1` 与 atomic `RenamePlanV1` contract 已接入固定 LSP 3.17 版本的 server package，并完成
fail-closed trust、multi-root 隔离、overlay、watched-file routing 与 latest-wins scheduling。
本里程碑目标版本线为 `0.6.0`，交付公开 `@tokenc/language-server` 与薄、可安装的 VS Code client。
契约、workspace、trust、cancellation、功能、benchmark 与发布顺序已在
[M3 执行计划](M3-PLAN.zh-CN.md)中固定。

交付物：

- `@tokenc/language-server`。
- 薄 VS Code extension。
- completion、definition、references、hover、rename、code action。
- Context-aware diagnostics 和 resolved-value preview。
- 大工作区启动、更新与取消请求的性能预算。

退出条件：

- LSP 与 CLI 对同一 snapshot 返回一致诊断。
- rename 在写文件前发现 canonical ID 和目标 Backend 的冲突。
- 编辑无效 JSON 后服务不崩溃，修复后自动恢复。
- 性能测试覆盖冷启动、单文件 edit 和高 fan-out Token edit。
- 协议层没有复制 Frontend 或 Graph 逻辑。

### M4 — 受控生态扩展

**目标：** 在核心契约稳定后扩大平台覆盖，而不牺牲确定性。

候选交付物按真实用户需求排序：

- 只读 Lint Rule SDK。
- Importer SDK 与一个参考 Importer。
- Sass、Swift 或 Kotlin Backend；一次只推进需求最明确的目标。
- Vite/esbuild/Rollup integration。
- 可选持久化 build cache。
- 只读 Web 依赖图或 CI 报告 viewer。

退出条件：

- 第三方扩展具有 compatibility test kit。
- 扩展 API 有明确的版本兼容和 capability negotiation。
- 插件无法修改已链接的 semantic snapshot。
- 新 Backend 通过共同的 type/reference/context conformance suite。
- 持久化缓存开启与关闭时输出字节一致。

## 6. 跨里程碑工作流与优先级

| 工作流              | M0                 | M1                    | M2               | M3                  | M4           |
| ------------------- | ------------------ | --------------------- | ---------------- | ------------------- | ------------ |
| DTCG conformance    | 基线与已知缺口     | 扩大 fixture          | permutation      | IDE diagnostics     | 持续维护     |
| Conditional graph   | 修正环检测         | 完整查询/失效         | diff/impact      | references/rename   | 插件查询     |
| Backend correctness | CSS/Tailwind 修复  | capability/symbol API | 输出影响         | rename preview      | 新 Backend   |
| Incremental engine  | 正确性 fixture     | Session API           | snapshot diff    | LSP 持有 Session    | 持久 cache   |
| Diagnostics         | 补齐错误位置       | schema v1/fix         | SARIF            | code action         | lint SDK     |
| Interop             | `$schema`/扩展保留 | loader API            | Terrazzo adapter | workspace discovery | Importer SDK |

每个功能按以下顺序评估：

1. 是否修复静默错误或数据损失？
2. 是否强化 correct、explainable、incremental、embeddable 四项承诺？
3. 是否被至少两个客户端复用，例如 CLI 与 LSP？
4. 是否可以用 conformance、differential 或 benchmark 自动验证？
5. 是否会扩大公共 API，而收益只属于单一 Backend？

前四项得分高的工作优先。只增加表面格式数量、且不能强化核心承诺的工作延后。

## 7. 测试与质量战略

### 7.1 测试层级

- **Parser conformance**：DTCG 规范示例、JSON Pointer、`$root`、`$extends`、metadata。
- **Semantic fixtures**：类型推断、Context predicate、循环、unknown reference、Resolver composition。
- **Differential tests**：增量 snapshot 与全量 compile 的结果逐项相同。
- **Backend conformance**：每个类型、引用策略、Context 策略和名称碰撞。
- **Golden output**：只用于稳定 serialization，不替代语义断言。
- **Property/fuzz tests**：Token ID、JSON Pointer、Graph patch 和 Context predicate。
- **Performance benchmarks**：冷编译、无变化重编译、低/高 fan-out edit、多 permutation。
- **End-to-end tests**：CLI exit code、原子写入、watch 恢复、LSP edit cycle。

### 7.2 基准数据集

至少维护四类可重复 fixture：

| Fixture               | 目的                                     |
| --------------------- | ---------------------------------------- |
| Small conformance     | 快速覆盖每个语义规则                     |
| Wide graph            | 测量大量独立 Token 和 parse/link 成本    |
| Deep graph            | 测量 alias chain、循环与 stack safety    |
| High fan-out contexts | 测量影响传播和 `(TokenId, Context)` 缓存 |

与 Terrazzo 的性能对比必须固定 Node 版本、硬件、输入、冷/热缓存、输出目标和运行次数，并同时报告中位数、
p95、峰值内存与实际重算 Token 数。架构更细粒度不自动等于实测更快。

### 7.3 发布门槛

每个公开 release 必须满足：

- clean checkout 的 format、lint、typecheck、build、test 全部通过。
- DTCG 支持矩阵同步更新。
- 公共行为变化包含中英文文档和 changeset。
- 新 Diagnostic code、JSON schema 或 CLI machine output 有兼容说明。
- Backend golden files 和 deterministic build 检查通过。
- 性能关键路径没有超过约定预算；预算变化需要在 release notes 中解释。

## 8. 成功指标

### 8.1 正确性

- DTCG 生态案例按“通过、明确不支持、外部扩展、实现缺陷”分类覆盖率。
- 静默生成无效产物的已知案例数必须为零。
- 增量与全量编译 differential mismatch 必须为零。
- 所有 semantic error 都有稳定 code 和 primary source location。

### 8.2 性能

- 冷编译时间和峰值内存。
- 单文件编辑后重新解析的文件比例。
- 重新检查、重新求值的 Token/Context 比例。
- 低 fan-out 与高 fan-out 编辑的 p50/p95 latency。
- Compiler Session cache hit rate。

具体数值预算应先由公开 benchmark baseline 建立，不能凭空设置一个不代表真实项目的毫秒目标。

### 8.3 采用与价值

- 使用 `check`/`diff` 而不使用 Backend 的项目数。
- LSP 周活工作区和平均诊断响应时间。
- CI 中发现的 breaking Token change 数量。
- 被 CLI、LSP、CI 三个客户端共同复用的 Core API 比例。
- 第三方 Backend/Rule 是否能只依赖公开 API 完成。

下载量和 Backend 数量可以记录，但不作为首要 north-star metric。

## 9. 风险与控制

| 风险                   | 后果                      | 控制方式                                   |
| ---------------------- | ------------------------- | ------------------------------------------ |
| 过早复制 Terrazzo 功能 | 资源分散，核心优势不清晰  | 用四项产品承诺过滤 roadmap                 |
| 条件图复杂度失控       | Cycle/impact 行为难以证明 | 先定义 predicate algebra 和 truth fixtures |
| 公共 API 过早拆包      | 频繁破坏兼容              | 先内部模块化，稳定后发布 package           |
| 过度严格损害采用       | 常见项目无法接入          | 将标准错误、未知扩展、policy lint 分层     |
| 插件破坏确定性         | 缓存与诊断不可复现        | 扩展只读、分阶段、声明 capability          |
| LSP 与 CLI 漂移        | 同一项目出现不同结果      | 两者必须消费同一 Session snapshot          |
| 性能宣传缺乏证据       | 信任受损                  | 公布 fixture、命令和完整 benchmark 方法    |
| 单维护者范围过大       | 路线图长期无法交付        | 以退出条件逐个完成里程碑，不并行铺开生态   |

## 10. 决策与贡献流程

以下改动需要先提交简短 RFC：

- 新的 Core 源语言语法或 tokenc extension。
- `TokenNode`、Graph edge、Compilation IR 的破坏性修改。
- 新的公共扩展类型或允许扩展修改语义状态。
- Diagnostic schema、machine-readable CLI schema 的破坏性修改。
- 新 package 或跨 package 依赖方向。

RFC 至少回答：用户问题、为何不能用现有 API、语义与失败模式、增量失效影响、诊断设计、兼容策略、测试
计划和被明确排除的方案。

普通 issue 应标注所属工作流和里程碑，例如：

```text
area:graph       milestone:M0       kind:correctness
area:session     milestone:M1       kind:architecture
area:ci          milestone:M2       kind:product
area:lsp         milestone:M3       kind:developer-experience
```

每完成一个里程碑，应更新本文的状态、删除已失效假设，并把已交付行为转入架构文档或支持矩阵。路线图不应
成为第二份长期失真的功能说明。

## 11. 下一步执行清单

M0 已完成并以 `0.3.0` 发布。M1 按详细[执行计划](M1-PLAN.zh-CN.md)依次推进：

1. 在下一次公开发布前补齐发布完整性：验证已存在的 registry 产物与 dist-tag、只允许从 `main`
   发布、保护 npm environment，并自动执行发布后核对。
2. 在可重复 corpus 上测量条件循环投影与端到端增量成本。
3. 审查并通过 Conditional Graph、Snapshot/Session、Backend/Diagnostic 三份 RFC。
4. 实现条件边、稳定 Query/Trace、Diagnostic v1 与共享 Backend contract。
5. 建立不可变 Snapshot 和公共 Compiler Session，再证明增量与全量编译等价。
6. CLI 完整迁移到公共 API 后，才开始 diff、SARIF、LSP 或 adapter 工作。

这一路线的核心判断标准始终是：

> Terrazzo 可以负责把 Token 输出到更多地方；tokenc 必须负责证明这些 Token 在所有有效 Context 下是
> 正确的，并准确解释每一次变化。

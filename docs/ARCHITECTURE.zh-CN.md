# 架构设计

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

`tokenc` 使用编译器架构组织 Design Token：DTCG JSON 是源代码，Token Graph 是语义模型，Context Resolution 是求值过程，Type Checker 负责静态分析，Backend 则是代码生成器。

## 编译流水线

```text
严格 DTCG / tokenc 兼容文档
  → Dialect Parser + Normalizer
  → typed TokenNode[] + structured diagnostics
  → 可选 DTCG Resolver sets/modifiers/resolutionOrder
  → TokenGraph
  → Context validation + reference type checking
  → lazy TokenResolver
  → Compilation IR
  → TokenBackend.emit(compilation)
  → OutputFile[]
```

高层 `compile()` API 负责加载文件并执行完整流水线；`compileDocuments()` 接受虚拟输入。Core 中的任何阶段都不会直接写入输出文件或终止进程。

## Dialect 与归一化边界

DTCG 2025.10 是标准源语言。显式 `dtcg-2025.10` dialect 校验严格结构化值；v0.x 默认的 `tokenc` dialect 保留 CSS 颜色字符串等便利写法。两条路径都会在 Graph 构建前归一化，因此 Checker、Resolver、IR 与 Backend 无需理解源语法差异。

Parser 与 DTCG Format/Color 校验分离。Core 保留颜色语义，序列化或转换仍是 Backend policy。准确支持范围参见 [DTCG 兼容矩阵](DTCG-COMPATIBILITY.zh-CN.md)。

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

Group 会把最近的 `$type` 传递给子节点。只有拥有 `$value` 的对象才会成为 Token；同时拥有 `$value` 与子节点的非法结构会被诊断。保留字 `$root` Token 会显式保留在 canonical path 中。

## Typed AST

核心模型是显式的数据结构：

```text
TokenNode
  id: TokenId
  type: TokenType
  value: TokenLiteralExpression | TokenReference
  overrides: ContextOverride[]
  dependencies: TokenId[]
  source: SourceLocation
```

`color`、`dimension`、`fontFamily`、`number`、`duration` 和 `fontWeight` 具有具体的内部模型和 validator。`TokenExpression<T>`、`TokenNode<T>`、`ResolvedToken<T>` 与 `CompiledToken<T>` 会让声明类型贯穿整个流水线。

复合类型在 v0.1 中保留 JSON-safe 数据。这允许未来逐步加强 validator，而不需要改变 Graph 或 Backend 边界。

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

`TokenGraph` 维护三个索引：

```text
Map<TokenId, TokenNode>       tokens
Map<TokenId, Set<TokenId>>    forward dependencies
Map<TokenId, Set<TokenId>>    reverse dependents
```

Token 和邻接关系查询为 O(1)。使用 lexical heap 的稳定 Kahn 排序为 O((V + E) log V)；迭代式环检测、affected traversal 与 impact analysis 为 O(V + E)。

`TokenGraph.patch()` 原位更新 Token、正向边和反向边索引，返回 Graph Delta，并合并 patch 前后的反向影响集合，确保边被删除或改向时仍然正确。

`explain` 和 `usages` 都直接查询同一张 Graph，不会搜索源文件字符串。

循环引用会输出闭合路径和相关源码位置。未知 Reference 仍然会作为 Graph Edge 保留，让 Checker 可以根据所有 canonical ID 提供相似名称建议。

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

基础值和稀疏兼容 override 都保留在同一个 Token Node 上。选择顺序为显式 precedence、匹配维度数量、配置中的维度顺序，不再依赖 JSON 声明顺序。

解析过程是惰性的，并以 `(TokenId, Context)` 为 key 缓存。Compiler 只记录 default context 和源码实际声明的 override 组合，不会物化 theme × brand × density 的完整 Token Dictionary。

`$extensions["org.token-compiler.contexts"]` 继续作为兼容语法，并归一化成由同一个 `TokenResolver` 消费的强类型 Context Override。

## DTCG Resolver Module

`parseResolverDocument(content, source)` 是不执行 IO 的 DTCG 2025.10 Resolver Frontend。它生成带源码位置的 `TokenSet`、`ResolverModifier`、`ResolutionSource` 与有序 Resolution Item。IO 层加载相对路径完整文件；语义解析负责校验 Input、展开同文档 Set 引用、选择 Modifier Context，并严格按照 `resolutionOrder` 产生 Source Stream。

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

Diagnostic 包含稳定 error code、severity、message、primary source、related source 和可选 suggestion。

Core 不负责终端颜色和打印；CLI 可以把同一结构渲染成 code frame 或 machine-readable JSON。

Graph Cycle 会在递归求值前独立校验，因此用户看到的是完整依赖路径，而不是运行时堆栈错误。

## Compiler IR

`Compilation` 是 Backend 唯一可以消费的输入。它还公开强类型 `tokensOfType()` 视图与结构化 `explainToken()` trace，并继续提供：

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

CSS 和 TypeScript 是编译目标，不是格式化 callback。Backend 接收完整的语义 Compilation，并通过一个方法返回 `OutputFile[]`：

```ts
interface TokenBackend {
  name: string;
  emit(compilation: Compilation): Promise<readonly OutputFile[]> | readonly OutputFile[];
}
```

公共 API 不暴露 transform、filter、action、formatGroup 等复杂 hook 分类。这能避免平台规则泄漏到 Parser 或 Resolver。

## Backends

### CSS

生成 canonical CSS Custom Properties。

- `preserve` 将 Reference 映射为 `var()`。
- `resolve` 内联最终求值结果。
- Context selector block 与默认环境比较，只输出变化的声明。

### TypeScript

Flat mode 生成拓扑排序后的 binding，并支持 symbol reference。Object mode 生成嵌套的 `as const` 对象；必要时 symbol mode 会创建内部有序 binding。

### Tailwind v4

生成三部分内容：

- `--token-*` runtime property
- 稀疏 Context override
- Tailwind `@theme` binding

Tailwind variable 指向运行时层，因此普通 CSS 和 utility 可以共享同一份值，theme switching 也不需要复制完整语义 Token Store。

## Incremental Compilation

`IncrementalCompiler` 以 source 为 key 缓存已解析 Document。文件变化时：

1. 只解析发生变化的 Document。
2. 比较语义节点签名，得到 changed Token IDs。
3. 仅 patch 新增、修改、删除的 Graph Node 与邻接边。
4. 合并 patch 前后的 reverse affected set。
5. 在 affected region 内检查 Reference 与 Cycle；无效构建后的下一次编辑回退为全量检查。
6. 将 affected set 以外的求值缓存迁移到新 Resolver。
7. 在 IR 或 Backend 请求值时，惰性重算受影响节点。

Backend 在 v0.1 中仍可能重写完整文件，但这不会导致 Core 重新解析或重新求值无关 Token。

Add、change 和 remove 使用同一套 invalidation 逻辑。无效 JSON 只替换对应的缓存 Document；修复后下一次 edit 可以恢复编译。

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
```

未来可以加入第三种 `ComputedTokenNode`。Computed Node 会在 Graph Construction 前提供 dependencies，Function Parsing 和 Evaluation 作为新的 Compiler Stage 实现，而 Backend 继续消费相同的 Resolved IR。

v0.1 不会为了提前支持这个能力而创造非标准 Function Syntax。

## Package 边界

```text
@tokenc/core
  ↑
  ├─ @tokenc/backend-css
  ├─ @tokenc/backend-tailwind
  ├─ @tokenc/backend-typescript
  └─ @tokenc/cli → backends
```

Core 不会导入 CLI 或 Backend。Backend 只依赖公开的 Core IR。CLI 负责配置加载、文件写入、终端输出、进程信号和 watcher 生命周期。

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

# RFC 0001：条件依赖图

[English](0001-conditional-graph.md)

- 状态：已接受
- 里程碑：M1-02 / M1-03
- 更新：2026-08-30

## 摘要

tokenc 将每一次依赖写法保留为带来源的 `DependencyOccurrence`，再根据 Context override 的胜出规则，
生成带精确 `ContextPredicate` 的 `DependencyEdge`。Predicate 使用有限 Context domain 上的规范化、不相交
DNF 表示，因此对交、并、补和差集闭合。条件边成为循环检查、查询、影响分析和增量失效的唯一事实源。

项目处于 `0.x`。本 RFC 直接替换 `TokenNode.dependencies` 和 `TokenGraph` 的 ID-only 公共查询，不提供兼容
视图或迁移期。

## 用户问题

当前 Graph 将 base 与所有 override 的依赖压缩为 `TokenId → Set<TokenId>`。它无法回答：

- 某条引用写在什么字段和源码位置；
- 哪些 Context 会实际选择该引用；
- 两条边能否在同一个 Context 中同时生效；
- 一次编辑只影响哪些 `(TokenId, Context)`；
- `usages`、`impact` 和循环诊断为什么得到当前结果。

Checker 目前通过枚举相关 Context，重新调用候选选择逻辑来弥补 Graph 的信息损失。这形成了两套语义，
也让 Query API 无法复用 Checker 已经知道的事实。

## 决策

### 1. 保留每一次 dependency occurrence

Frontend 和 Linker 在任何去重之前产生：

```ts
interface DependencyOccurrence {
  readonly id: string;
  readonly owner: TokenId;
  readonly candidate: CandidateId;
  readonly target: TokenId;
  readonly kind: "alias" | "json-pointer" | "inheritance" | "composite-field";
  readonly fieldPath: readonly (string | number)[];
  readonly source: SourceLocation;
  readonly sourceOrder: number;
}
```

`id` 由 source document identity、owner、candidate、field path、source offset 与同位置序号确定性生成。它只
用于同一 source revision 内的身份和排序，不承诺跨内容编辑保持不变。

重复 occurrence **保留为多条 edge**，不聚合。即使 `from`、`to` 和 condition 相同，不同 composite
field、JSON Pointer 或源码位置也必须能独立跳转和诊断。需要集合视图的 Query 在返回层显式去重。

### 2. Candidate 排序是唯一的胜出规则

每个 Token 有一个 base candidate 和零个或多个 override candidate。override 的排序键依次为：

1. 显式 `precedence`，数值越大越优先；
2. selector specificity，约束维度越多越优先；
3. 按 `ContextDefinition` 声明顺序从后向前比较“是否约束该维度”；
4. source order，先出现者优先。

相同 raw selector 的重复 override 仍是 `TOKEN_RESOLUTION_AMBIGUOUS`，不会依靠 source order 消除错误。
base 的 raw predicate 是整个有效 Context universe，且排在所有有效 override 之后。

Candidate 的 raw selector 只表示“可以参与竞争”，不等于实际生效区域。其有效条件为：

```text
effective(candidate) = raw(candidate)
                     − union(raw(candidate with a higher winner rank))
```

candidate 中的每个 occurrence 都继承同一个 effective predicate。空 predicate 不生成 edge，但 occurrence
仍保留，供 explain 和诊断说明其被完全遮蔽。

### 3. Predicate 使用规范化、不相交 DNF

Predicate 的 universe 来自经过校验的 `ContextDefinition`；每个维度是有限字符串集合。内部表示为若干
不相交 clause 的有序集合，每个 clause 保存各维度允许值集合：

```ts
interface ContextClause {
  readonly dimensions: ReadonlyMap<string, ReadonlySet<string>>;
}

interface ContextPredicate {
  readonly clauses: readonly ContextClause[];
}
```

- `false` 是空 clause 列表；`true` 是一个对所有维度取完整 domain 的 clause。
- 省略维度等价于该维度完整 domain，序列化时省略完整 domain。
- clause 内按维度名、值声明顺序规范化；clause 列表按稳定序列化排序。
- 规范化删除空 clause、重复 clause 和被其他 clause 完全包含的 clause，并拆分重叠区域，使 clause 两两
  不相交。
- `matches`、`intersect`、`union`、`complement`、`subtract`、`isSatisfiable` 必须精确，不允许把非凸结果
  近似成一个 conjunction。

所有会扩张 clause 数量的运算先估算结果大小。每次运算最多产生 16,384 个规范化 clause；超限返回
`TOKEN_CONTEXT_PREDICATE_LIMIT`，包含操作、candidate、相关维度和估算大小，不分配部分结果。该初始上限
沿用 M1-01 已测量的投影安全界限，以后只能依据 benchmark 和回归测试调整。

### 4. 条件边是唯一 Graph 事实

```ts
interface DependencyEdge {
  readonly occurrence: DependencyOccurrence;
  readonly from: TokenId;
  readonly to: TokenId;
  readonly condition: ContextPredicate;
}
```

Graph 为 edge 建立 `(from, to, occurrence.id)`、forward 和 reverse 索引。所有索引只引用同一批不可变
edge。不存在另一份 `Set<TokenId>` 邻接事实。

循环成立当且仅当一条闭合路径上所有 edge condition 的交集可满足。诊断返回闭合 edge path、其可满足
predicate 和一个确定性的 witness Context；每一段 related location 指向具体 occurrence。无需再枚举整个
Context 笛卡尔积。

`dependencies`、`usages` 和 `impact` 查询必须接收可选 Context 或 Predicate：

- 指定 Context 时，只返回 `condition.matches(context)` 的 edge；
- 指定 Predicate 时，返回与其交集可满足的 edge及交集；
- 未指定时返回所有 occurrence，不隐式去重；
- 聚合 Token ID 是独立的显式 Query 操作。

### 5. 非法输入与诊断

未知维度、未知值和重复 selector 在构图前产生现有稳定诊断。对应 candidate 不生成 semantic edge。未知
target 仍生成 edge，使定义跳转、usage 和未知引用诊断共享同一 occurrence；target 是否存在是 Checker
事实，不是建边前提。

Predicate 复杂度错误、条件循环和未知引用都以 occurrence source 为 primary location。条件循环的
related locations 按路径顺序排列，不再仅指向 Token 定义。

## 增量失效

- 文档变化先比较 occurrence 与 candidate 的语义身份。
- occurrence 内容变化只重建 owner 的 outgoing edge；target 变化同时更新 reverse index。
- selector、precedence、ContextDefinition 或维度顺序变化会重新计算相关 Token 的 candidate effective
  predicates。
- edge condition 的增删改只失效与变化 predicate 相交的 resolver/query cache 项。
- cycle cache 按受影响的条件强连通区域失效；复杂度超限不得发布部分 Graph revision。
- source range 单独变化只更新 provenance，不使 resolved value cache 失效，但会产生新的 snapshot。

## 公共 API 变化

- 删除 `TokenNode.dependencies`、`baseDependencies` 和 override 上的 ID-only `dependencies`。
- 删除 `TokenGraph.getDependencies(id)`、`getDependents(id)` 及其 ID-only impact 结果。
- `TokenGraph.patch()` 不再公开；Graph revision 由 Session 构建并冻结。
- 新 Query API 返回 `DependencyEdge`、occurrence 或显式聚合结果。
- `compile` 和 CLI graph/usages/explain 在 M1-09 一次性迁移，不提供兼容 facade。

## 测试计划

- Characterization：全部 M0 cycle fixture 结果保持语义一致。
- 表驱动测试：base、override、缺省值、precedence、specificity 与维度顺序。
- Property tests：Predicate 布尔代数、闭合性、规范化幂等、序列化确定性。
- Fixture：部分重叠 selector、完全遮蔽、三维交集、base/override 真环与互斥伪环。
- Occurrence：同一 target 出现在多个 composite field、重复 JSON Pointer、跨文档来源。
- 增量 differential：每次 edge/predicate 更新与冷构建的 edges、cycles、queries 完全一致。
- 限制测试：在分配前稳定触发 16,384 clause 上限。

## 开放问题

无。评审若否决某项决定，必须在本节记录替代决定及理由后才能接受 RFC。

## 明确不做

- 不支持无限或正则表达式 Context domain。
- 不开放任意用户布尔表达式语法。
- 不用近似 predicate 换取性能。
- 不保留 ID-only Graph 兼容视图。
- 不在本 RFC 中设计 Session、Diagnostic schema 或 Backend API；它们分别由 RFC 0002、0003 定义。

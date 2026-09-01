# RFC 0002：Compilation Snapshot 与 Compiler Session

[English](0002-snapshot-session.md)

- 状态：已接受
- 里程碑：M1-02 / M1-07 / M1-08
- 更新：2026-08-30

## 摘要

tokenc 以不可变 `CompilationSnapshot` 表示某一次完整、原子发布的编译事实，以长生命周期
`CompilerSession` 串行处理 source/config transaction。失败更新发布当前 invalid snapshot；最近一次成功
结果只能通过 `lastSuccessfulSnapshot` 显式取得。取消或内部异常不发布 snapshot。

本 RFC 直接删除可变 `Compilation`、`CompilationResult` 和 `IncrementalCompiler` 公共模型。`compile`
保留为一次性便利入口，但改为返回 snapshot；不提供旧结果形状或 facade。

## 用户问题

当前 `IncrementalCompiler` 原地修改 Graph，再替换 `result`。调用者无法安全地长期持有旧结果，也无法区分
“当前 source 无效”和“上一次成功产物”。更新只覆盖单文件 update/remove，配置、Resolver、取消、并发和
虚拟 Loader 没有统一事务语义。CLI、未来 CI 与 LSP 因而可能各自实现不同的生命周期。

## 决策

### 1. Snapshot 是一次发布的不可变事实集

```ts
type CompilationSnapshot = ValidSnapshot | InvalidSnapshot;

interface SnapshotBase {
  readonly revision: number;
  readonly graphRevision: number;
  readonly sourceRevision: string;
  readonly diagnostics: readonly Diagnostic[];
  readonly query: CompilationQuery;
  readonly stats: CompilationStats;
}

interface ValidSnapshot extends SnapshotBase {
  readonly status: "valid";
  readonly ir: CompilationIR;
}

interface InvalidSnapshot extends SnapshotBase {
  readonly status: "invalid";
  readonly ir?: never;
}
```

- `revision` 在一个 Session 内每次成功发布 transaction 后单调加一，包括 invalid snapshot。
- `graphRevision` 只在 semantic graph 变化时增加；纯 source range 或 Backend 配置变化不会增加。
- `sourceRevision` 是全部输入内容、Resolver 输入和语义相关配置的确定性 digest，不含时间或绝对工作目录。
- Snapshot 的集合、Graph、Query 索引、Diagnostic 和 IR 在发布后均不可变；TypeScript `readonly` 之外，
  实现不得泄露可修改的 `Map`、`Set`、数组或内部节点。
- 旧 snapshot 与新 transaction 完全隔离，可被不同任务并发读取。

Invalid snapshot 保留所有能够可靠建立的 source、parse、occurrence 和 Graph 查询事实。需要完整类型解析的
`resolve`/`explain` 返回显式 `{ status: "unavailable", diagnostics }`，而不是偷偷读取旧成功值。
Backend planning 只接受 `ValidSnapshot.ir`。

### 2. Session 原子串行提交更新

```ts
interface SessionTransaction {
  readonly documents?: readonly DocumentChange[];
  readonly config?: CompilerConfiguration;
  readonly resolverInput?: CompilationContext;
}

interface CompilerSession {
  readonly currentSnapshot?: CompilationSnapshot;
  readonly lastSuccessfulSnapshot?: ValidSnapshot;
  apply(
    transaction: SessionTransaction,
    options?: { signal?: AbortSignal },
  ): Promise<CompilationSnapshot>;
  close(): Promise<void>;
}
```

`DocumentChange` 是 `add | update | remove` 的判别联合；一次 transaction 可以包含多个文件和一次配置变化。
Session 在私有 staging state 上完成 load、parse、link、graph、check、resolve 与 plan 前置事实，最后用一次
原子赋值发布 snapshot。

同一个 Session 的 `apply` 按调用顺序 FIFO 串行执行。读取 snapshot 不等待正在进行的 transaction。
transaction 内同一 document identity 出现互相冲突的操作时，以 `SESSION_CONFLICTING_CHANGE` 失败并发布
invalid snapshot；不使用“最后一个操作获胜”。

### 3. 失败、取消和异常有不同语义

- 用户输入、配置或语义诊断导致的失败是正常编译结果：发布新的 `InvalidSnapshot`，更新
  `currentSnapshot`，不更新 `lastSuccessfulSnapshot`。
- 后续修复成功时发布 `ValidSnapshot` 并同时更新两者。
- AbortSignal 在任一阶段触发时，transaction 以 `AbortError` reject，丢弃 staging state，不增加 revision，
  不改变两个 snapshot 指针；后续 transaction 可继续。
- Backend/Loader 抛出的未建模异常是 API reject，同样不发布 snapshot。可预期失败必须转换为 Diagnostic，
  不能依赖 throw 控制流程。
- `close()` 幂等；关闭后新 apply 以 `SESSION_CLOSED` reject，不改变已有 snapshot。

### 4. Loader 是可注入的 IO 边界

```ts
interface DocumentLoader {
  load(request: DocumentRequest, signal?: AbortSignal): Promise<LoadedDocument>;
}
```

Core 只定义 request/response、canonical document identity、content、origin 和可选 version；不执行网络请求。
CLI 提供 filesystem loader，宿主可提供内存或远程 loader。所有相对引用由 Loader 根据 requesting document
解析并返回 canonical identity，Core 不猜测 URL 或路径语义。

同一 transaction 中同一 canonical identity 必须只加载一次。Loader 返回的 version 仅作优化提示；
sourceRevision 始终由实际内容保证正确性。

### 5. Cache ownership 与阶段边界

M1-08a 先实现无缓存 Session，建立 differential oracle；以下 cache 只能在 M1-08b 逐项加入：

| 阶段         | owner            | 最小 key                                                  | 失效原因                     |
| ------------ | ---------------- | --------------------------------------------------------- | ---------------------------- |
| Load         | host/loader      | request + loader policy                                   | host-defined                 |
| Parse        | Session          | document identity + content digest + parser version       | 内容或 parser 变化           |
| Link         | Session          | parsed document digests + resolution order                | 文档集合/顺序/Resolver 变化  |
| Graph        | Session          | occurrence/candidate semantic digests + ContextDefinition | edge 或 Context 变化         |
| Resolve      | Snapshot builder | graph revision + TokenId + canonical Context              | 相交条件边变化               |
| Backend plan | 默认不缓存       | 仅 Backend 提供完整稳定 key 时允许                        | IR、options 或 callback 变化 |

每个 cache 必须报告 hit、miss、reused、recomputed 和 invalidation reason。没有 differential oracle 证明与
无缓存 Session 相同，不得启用 cache。

### 6. 一次性编译与公共替代关系

- `createCompilerSession(options)` 是主入口。
- `compile(options, { signal })` 创建临时 Session、执行一个 transaction、返回
  `CompilationSnapshot` 后关闭 Session。
- `compileDocuments` 合并到基于 document changes 的一次性入口。
- 删除公共 `Compilation`、`CompilationResult`、`IncrementalCompiler` 和 `TokenGraph.patch()`。
- 定义、补全、resolve、explain、dependencies、usages 与 impact 全部经 `snapshot.query`。
- CLI `build/check/dev` 在 M1-09 一次性迁移；不存在双轨期。

## 配置变化与失效

- source set/Resolver source 变化：重新 load 变化闭包，并重建受影响 Link/Graph facts。
- ContextDefinition 或 resolution order 变化：Graph predicate、cycle、resolve 全部相关区域失效。
- checker policy 变化：复用 Graph，重跑相应 Checker。
- Backend 选项变化：不改变 Graph revision，只使对应 plan 失效。
- cwd/Loader policy 变化：重新 canonicalize 并加载所有可能受影响的 document identity。
- 纯输出目录变化：只重做 artifact-path planning。

## 诊断

Session 生命周期诊断使用 `SESSION_*` code；source、Graph 和 Backend 诊断分别由所属阶段产生。Snapshot
聚合并稳定排序：source identity、primary offset、severity、code、fingerprint。失败 transaction 的诊断只
描述当前 source，不混入 last successful snapshot 的诊断或输出。

## 测试计划

- add/update/remove/reconfigure 多文件原子 transaction。
- invalid → invalid、valid → invalid、invalid → valid 状态转换。
- 持有旧 snapshot 时并发读取新旧 query/resolve/plan，验证无可观察 mutation。
- 同时提交多个 apply，验证 FIFO revision 与确定性结果。
- 每个阶段取消，验证 revision、current 和 lastSuccessful 均不变且后续可恢复。
- Loader identity、相对引用、重复加载、虚拟文档和 Loader failure。
- 无缓存 Session 对每个 mutation 与 cold compile 比较 diagnostics、edges、values、trace 和 output bytes。
- M1-08b 为每个 cache 增加命中/失效计数与同一 differential 门禁。

## 开放问题

无。评审若否决某项决定，必须在本节记录替代决定及理由后才能接受 RFC。

## 明确不做

- 不提供跨进程或磁盘 cache。
- 不允许并行写 transaction 或自动合并冲突。
- 不让 invalid snapshot 回退读取旧成功值。
- 不把文件监听、debounce 或网络重试放进 Core；这些属于宿主。
- 不保留 `IncrementalCompiler` facade、旧 `CompilationResult` 形状或 deprecation alias。
- 不在 M1 实现 diff、SARIF、LSP 或持久化项目 daemon。

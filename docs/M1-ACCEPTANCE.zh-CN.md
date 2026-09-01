# M1 Release Candidate 验收记录

[English](M1-ACCEPTANCE.md)

> 验收结论：**`0.4.0` release candidate 通过；最终关闭里程碑仍需获得授权后执行实际发布与发布后验证。**
>
> 本地验收日期：2026-08-31。源码基线：基于 `main@07f4490` 的 M1 工作区。
> 发布基线：五个版本统一为 `0.4.0`、目标 dist-tag 为 `next` 的候选包。

## 1. 验收决定

M1-00 至 M1-10 的实现已经完成，五项官方退出条件均有自动化证据。公共编译器边界现已收敛为不可变的
`CompilationSnapshot`、`CompilerSession`、`CompilationQuery`、`CompilationIR` 与 Backend planning
契约；条件查询、版本化 Diagnostic/Trace、精确阶段缓存指标和 differential 正确性验证均已进入候选版本。

本记录不声称 `0.4.0` 已发布。npm 发布、registry 安装消费验证、provenance 验证和远端 annotated tag
验证都会改变外部状态，必须通过已授权的发布工作流执行。只有这些检查全部通过后，M1 才能在操作层面
正式关闭。

## 2. 退出条件证据

| M1 退出条件                               | 结果 | 自动化证据                                                                                                                                                                         |
| ----------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单文件编辑不重新解析未变化文件            | 通过 | Session cache 测试断言 parse/link 复用与精确失效；`vp run bench:gate` 固定 10,012 Token 单点编辑用例，只允许解析 1 个文档，并要求至少命中 2 个 parse cache。                       |
| 增量输出等于全量编译                      | 通过 | full-vs-Session oracle 覆盖 48 步固定 corpus、四组可复现的 32 步 seeded property sequence，以及 Resolver Context/input mutation，并比较 Diagnostic、条件边、值、Trace 和输出字节。 |
| 同一 Snapshot 并发读取确定                | 通过 | Snapshot 测试并行执行 query/resolve/emit、验证旧 Snapshot 隔离，并对 1,024 路 high-fan-out Graph 发起 16 路并发读取，逐字节比较结果。                                              |
| Backend 在 emit 前发现全部 planning error | 通过 | Core 与内置 Backend 测试覆盖 capability、符号规范化、不可表达值、产物路径、跨 Backend 碰撞、失败时 zero-emit，以及 plan 与实际输出严格一致。                                       |
| 公共消费者不使用私有旁路                  | 通过 | CLI/Core parity 测试覆盖 Diagnostic、Context Query 与 Trace；architecture test 禁止 CLI 和全部内置 Backend deep import Core，并要求 CLI 通过 `CompilerSession` 编译。              |

## 3. Release candidate 验证

保留的源码门禁为：

```bash
vp run verify
```

它依次检查 package 版本一致性、格式、lint、类型、全部 package build、公共契约锁、完整测试套件与确定性
性能门槛。最终本地执行通过 38 个测试文件、382 项测试。公共契约锁覆盖五个 package 的 declaration 输出，
以及 Diagnostic v1 与 Explain Trace v1 JSON Schema。

发布打包已在不发布的前提下验证：

```bash
vp run publish-packages --dry-run --tag next
vp run verify-release --phase packed --tag next --output <temporary-directory>
```

两项检查均对精确的五包 `0.4.0` 集合通过。packed 检查验证 manifest、内部依赖范围、tarball 内容、
package exports，并在隔离消费环境中运行 Core、CLI 与三个内置 Backend 的 smoke test。

完整候选源码还被提交到隔离的临时 clone 中；该副本内的 `vp run verify` 与 packed 验证均通过，随后
`git status --porcelain --untracked-files=all` 保持为空。这在不提交或修改用户工作分支的前提下证明了
clean-checkout 门禁。

可移植性能门槛有意使用语义工作量 counter，不把跨机器 wall time 作为硬门槛。单点编辑预算为：changed
Token 不超过 1、affected Token 不超过 12、reparse 文档不超过 1、relink 文档不超过 2、重算 resolution
不超过 12；同时要求至少复用 2 个 parse entry、1 个 Link 文档和 10,000 个 resolution。同环境 wall time
只作为建议性证据，详见 [M1 性能门槛](M1-PERFORMANCE-GATES.zh-CN.md)。

## 4. 公共稳定边界

只有 package manifest exports 属于公共接口。Core 公开根 API、Diagnostic v1 Schema 与 Explain Trace v1
Schema；可变 Graph/Resolver/build state 及源码 deep import 均为内部实现。M1 不为旧接口保留兼容 facade
或 deprecated alias。

`contracts/m1-public-contracts.json` 保存 declaration 与 Schema 的 SHA-256 快照，并由 CI 和发布自动化中的
`vp run check:contracts` 强制检查。未来有意修改公共接口时，必须同步更新实现、文档、Changeset 与契约
快照。受支持的工作流和直接替代关系见 [M1 API 稳定边界](M1-API-STABILITY.zh-CN.md)。

## 5. 仍需执行的操作性收尾

获得授权的发布操作人必须从最终已提交的 release source 完成以下外部步骤：

1. 通过受保护的 npm environment，以预期 dist-tag 发布五个 `0.4.0` package。
2. 运行 `verify-release --phase published`，验证 registry integrity、provenance source commit、
   dist-tag、精确 package 集合、内部依赖范围与 registry-installed consumer 行为。
3. 创建并推送五个 annotated package tag，再执行 local-tag 与 remote-tag 验证阶段。
4. 将 release commit、workflow run、registry 证据和最终“已关闭”结论回填本记录。

M1 已没有剩余源码实现工作。在上述外部操作获得授权并全部通过前，准确状态是“实现完成，`0.4.0`
release candidate 验收通过”，而不是“已发布并关闭里程碑”。

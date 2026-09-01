# M2 Release Candidate 验收记录

[English](M2-ACCEPTANCE.md)

> 验收结论：**实现已完成并通过 `0.5.0` release candidate 验收；最终关闭里程碑仍需获得授权后执行实际
> 发布与发布后验证。**
>
> 本地验收日期：2026-09-01。候选版本由五个同步版本的公共 package 组成，目标 dist-tag 为 `next`。
> 本次未发布任何 package，也未创建 tag。

## 1. 已验收范围

M2-00 至 M2-09 的实现已经完成。候选版本包含不可变 Snapshot Diff v1 与 Impact Report v1 fact、只读 Git
比较、breaking-change policy、共享 text/JSON/SARIF report、有界 Resolver permutation、最小权限 CI
配方，以及只使用公共边界的 Terrazzo adapter。M1 编译、Session、Query、Diagnostic 与 Backend planning
行为仍全部通过。

## 2. 退出条件证据

| M2 退出条件                              | 结果 | 自动化证据                                                                                                    |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------- |
| 区分直接、传播和 Context-specific impact | 通过 | Snapshot Diff 与 impact fixture 覆盖两侧 Graph、互斥 Context region，以及精确 direct/indirect 集合。          |
| SARIF 源码位置兼容 GitHub                | 通过 | Report 测试验证 SARIF 2.1.0 结构，以及跨格式 code、fingerprint、URI、region、related location 和 fix 一致性。 |
| Diff 输出版本化且确定                    | 通过 | Schema conformance、golden fixture、重复执行字节一致和 SHA-256 公共契约锁覆盖全部 M2 report schema。          |
| 中大型 fixture 完整遍历 impact           | 通过 | 1,200 Token 分层 fixture 检查精确 changed/direct/indirect 链；2,000 consumer fixture 检查完整 fan-out。       |
| Adapter 失败不改变 Core 语义             | 通过 | Terrazzo 示例只导入公共 package 边界，并测试不可变 handoff、loader failure 与 unsupported extension。         |

独立 M2 differential proof 还会运行一个固定 revision pair，以及四组各八个 revision 的 seeded sequence，
并覆盖 light/dark Context。它比较 structural/resolved fact、双 Graph impact、Backend symbol 与 artifact path、
policy rule/change identity、确定性 Report JSON fingerprint，以及 SARIF normalized fact/location；mismatch 为零。

## 3. 稳定命令与 Schema

面向 CI 的受支持命令为：

```bash
vp exec tokenc check --format json
vp exec tokenc check --format sarif
vp exec tokenc impact tokens/primitive.json --context theme=dark --format json
vp exec tokenc diff --base HEAD~1 --head worktree --format json
vp exec tokenc diff --base HEAD~1 --policy tokenc.policy.json --format sarif
```

`check` 与 `diff` 共享 Report v1；`impact` 输出 Impact Report v1。退出码 `0` 表示成功/通过，`1` 表示有效
比较存在未获允许的 error policy finding，`2` 表示无效或不完整。机器消费者应显式选择格式，并先验证
`schemaVersion` 再读取其他字段。

公共契约锁覆盖五个 package 的 declaration 和下列由 package export 的 JSON Schema：

- Core：Diagnostic v1、Explain Trace v1、Snapshot Diff v1、Impact Report v1 和 Breaking-change Policy v1。
- CLI：Report v1。

有意修改公共接口时，必须在同一次评审中同步更新实现、Schema、文档、Changeset 与
`contracts/m1-public-contracts.json`。

## 4. Policy、CI 与安全决策

Breaking-change Policy v1 采用 fail-closed。Token removal、type change、Context-coverage loss、Backend
symbol removal 与 artifact-path removal 默认是 error；direct/propagated value change 默认是 warning。
Context-scoped rule 和基于稳定 `changeId` 的 allow entry 可审计；无效 rule、陈旧 allow、编译错误与不完整
比较永远不能得到 pass。

Git 比较不会修改 checkout、index、branch 或 repository configuration；它只执行显式信任的当前 config，
绝不执行历史 config。参考 GitHub workflow 固定到 action commit SHA，只授予 contents read 权限；fork PR
只上传 artifact，不携带写权限执行不可信仓库脚本。详见 [CI 集成](CI.zh-CN.md)、
[发布安全](RELEASING.md)与 [Terrazzo 共存](TERRAZZO.zh-CN.md)。

## 5. 从 M1 / `0.4.x` 迁移

不需要兼容层，消费者可直接采用 M2：

1. 编译继续使用 `CompilationSnapshot` 与 `CompilerSession`。
2. 用 `compareSnapshots()` 和 `buildImpactReport()` 替换自建比较逻辑。
3. 用 `evaluateSnapshotPolicy()` 与 Policy v1 文档替换自定义 breaking check。
4. CI 格式统一改用 Report v1 JSON 或 SARIF。
5. 用 `planResolverPermutations()` 和有界 compile/compare helper 替换 eager Resolver 笛卡尔积。
6. Git 获取与第三方格式转换继续放在 Core 外，只传入不可变公共输入。

不支持 deep import、执行历史 config、无显式上限的 permutation，以及在自动化中解析人类可读文本。

## 6. Release candidate 验证

保留的源码门禁为：

```bash
vp run verify
```

它包含 M1 与 M2 语义工作量门槛。M2 锁定 1,200 Token 单文件 diff 的精确工作、2,000 个直接 consumer
的完整 impact，以及有界 3×4 Resolver 比较；首个 permutation 后 parse 与 link 重算均不得超过 2。跨机器
wall-clock latency 只作为建议值。
最终源码门禁通过 48 个测试文件、448 项测试和 12 项 declaration/schema 契约快照。

在不发布的前提下验证打包：

```bash
vp run publish-packages --dry-run --tag next

release_output="$(mktemp -d)"
vp run verify-release --phase packed --tag next --output "$release_output"
```

完整候选源码还必须在已提交的隔离 clean worktree 中通过 `vp run verify` 与 packed verification，并在完成后
保持 `git status --porcelain --untracked-files=all` 为空。

上述四项本地门禁均已通过。package dry-run 与 packed manifest 使用当前同步的 `0.4.0` package 版本；
已检查的 Changeset 计划会在获得授权的 version/release workflow 中对五个 package 执行一次统一 minor
升级，从而生成 `0.5.0`。

## 7. 仍需执行的操作性收尾

获得授权后，release workflow 必须发布 manifest 中精确的五个 package，再验证 registry-installed
消费、provenance、目标 dist-tag，以及全部本地和远端 annotated package tag。在这些外部检查通过前，
准确状态是“M2 实现完成，`0.5.0` release candidate 验收通过”，而不是“M2 已发布并关闭”。

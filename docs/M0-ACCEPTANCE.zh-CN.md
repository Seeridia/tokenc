# M0 阶段验收记录

[English](M0-ACCEPTANCE.md)

> 验收结论：**通过，附带下一次发布前必须完成的发布治理整改。**
>
> 验收日期：2026-08-25。代码基线：`main@3c66235`。发布基线：`0.3.0`，对应
> `2939441`。

## 1. 验收决定

M0“建立可信基线”的五项退出条件全部满足。已知名称碰撞、条件循环、Backend 值表达、产物路径碰撞和
发布版本错误都从静默行为变成了可测试的成功结果或结构化失败；五个公开包已经从 npm 发布并完成独立
消费验证。

本验收不代表发布治理已经没有改进空间。第 4 节中的 P0 项不影响 `0.3.0` 产物正确性，但必须在下一次
公开发布前完成。

## 2. 退出条件证据

| M0 退出条件                                             | 结果 | 证据                                                                                                                                                                                                 |
| ------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| collision 与 conditional-cycle fixture 全部通过         | 通过 | Core 覆盖互斥 selector、specificity、base/override、多维真环和 16,384 次投影上限；CSS、Tailwind、TypeScript 与 CLI 分别覆盖符号和输出路径碰撞。                                                      |
| Backend 不再静默输出 composite JSON                     | 通过 | CSS/Tailwind 对可表达 composite 生成平台值；gradient 和无法无损表达的形状在 emit 前返回 `BACKEND_UNSUPPORTED_VALUE`，且不产生部分产物。                                                              |
| clean checkout 上 check、build、test 全部通过并保持干净 | 通过 | GitHub Actions run [`32798153105`](https://github.com/Seeridia/tokenc/actions/runs/32798153105) 在 Node.js 22.13 与 24 上通过；21 个测试文件、272 项测试通过，CI 包含 build 后 clean-worktree gate。 |
| 支持矩阵与实现一致，每个未支持项具有稳定诊断            | 通过 | `DTCG-SUPPORT` 与固定的 `dtcg-examples@1.1.3` 回归集记录 7 个生态项目的 Token 数、Diagnostic code、数量及 unsupported/extension/gap 分类。                                                           |
| 发布包含修复与迁移说明的版本                            | 通过 | npm 五个公开包的 `latest` 均为 `0.3.0`，带 OIDC provenance；五个 annotated tag 都解析到 `2939441`；各 package changelog 记录行为和迁移影响。                                                         |

## 3. 发布产物复验

验收从一个临时空目录安装 npm 上的五个 `0.3.0` 包，而不是复用 Monorepo workspace：

- `@tokenc/core`
- `@tokenc/cli`
- `@tokenc/backend-css`
- `@tokenc/backend-tailwind`
- `@tokenc/backend-typescript`

独立 smoke test 使用已发布的 Core 编译一个 DTCG Dimension Token，并同时运行 CSS、Tailwind 和
TypeScript Backend，得到 `dist/tokens.css`、`dist/tailwind.css` 和 `dist/tokens.ts`；已发布 CLI 的
`--help` 也可以正常启动。

这次 consumer smoke 属于独立验收操作，其临时目录没有保留在仓库中。因此 M1-00 明确负责把它固化为
仓库脚本：发布前针对 packed tarball 运行，发布后针对 registry 安装结果运行；两条路径都将成为强制
发布证据，不再依赖操作人员临时执行。

可从验收提交复跑源码验证与合成 benchmark：

```bash
pnpm install --frozen-lockfile
pnpm verify
pnpm bench
```

上文链接的 CI run 是保留的源码验证记录。Registry provenance、tarball digest、tag 与 consumer smoke
目前仍是一次性验收观察；M1-00 必须用仓库内统一的 `verify-release` 命令补齐，并由本地与 publish
workflow 共同调用。

当前合成 benchmark 的一次本地观测值记录如下，仅用于建立 M1 测量起点，不构成性能承诺：

```text
Node.js 24.19.0, Apple M4 Pro, main@3c66235
cold compile: 1,000 independent tokens       26.02 ms
cold compile: 10,000 independent tokens     368.84 ms
cold compile: 10,000-token alias chain      412.67 ms
cold compile: 2,000-way fan-out              30.65 ms
cold compile: 1,000 themed tokens            25.63 ms
incremental: 1 primitive + 11 dependents    172.71 ms
```

增量用例只 patch 1 个 Graph node、影响并重算 12 个 Token，但仍需约 173 ms。这说明 M1 不能只报告
“affected token 数量小”，还必须测量并减少全量 relink、签名比较与其他固定成本。

## 4. 遗留风险与处理要求

### 下一次发布前必须完成

1. **发布重试完整性。** `publish-packages.mjs` 遇到 npm 已存在同版本时目前直接跳过。重试必须核对
   registry 产物身份、provenance 和请求的 dist-tag；如果相同版本先发布为 `beta`，随后以 `latest`
   重试，在单独评审的认证路径可安全更新 dist-tag 前，必须安全失败并给出明确的人工 promotion 指引。
2. **发布来源约束。** `publish.yml` 必须在 job 内拒绝非 `refs/heads/main` 的 ref；GitHub `npm`
   environment 需要配置 protected-branch policy，并建议增加人工 reviewer。

### M1 内完成

1. 发布后自动核对五个预期 package 版本、dist-tag、provenance commit 和远端 tag。PR #22 已改为逐个
   推送当前提交上的 tag，并在没有 tag 时失败，但还需要在下一次真实发布中验证完整闭环。
2. 将发布流程中仍使用浮动版本的 GitHub Actions 固定到完整 commit SHA。
3. 决定是否为每个统一版本创建一个 GitHub Release；它不是 npm 正确性的前置条件。

## 5. 移交

M0 自 2026-08-25 起归档为完成。后续语义与 API 工作进入
[M1 执行计划](M1-PLAN.zh-CN.md)，并以公共、可查询、可证明增量正确的编译器接口作为下一阶段唯一
主线；新增 Backend、LSP、SARIF 和 Terrazzo adapter 不进入 M1 范围。

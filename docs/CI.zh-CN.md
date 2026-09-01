# CI 集成

[English](CI.md)

即使 Design Token 产物仍由其他工具生成，也可以把 tokenc 作为只读校验与变更智能层。可直接参考
[`.github/workflows/tokenc.yml`](../.github/workflows/tokenc.yml)。

## 使用 Vite+ 安装与调用

把 CLI 和 `tokenc.config.ts` 引用的所有 Backend 固定为本地开发依赖，并通过 `vp exec` 调用本地 binary，
确保本地与 CI 使用同一版本，且 stdout 只包含选定报告：

```bash
vp install --frozen-lockfile
vp exec tokenc check --format text
vp exec tokenc diff --base HEAD~1 --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

`vp exec` 会直接转发参数，不要加入 npm 风格的额外 `--` 分隔符。交互式 package script 仍可使用
`vp run tokenc`，但它的任务标题属于 stdout；重定向 JSON 或 SARIF 时应使用 `vp exec tokenc`。

## 命令与退出码

生成前运行 `check`，在 revision 边界运行 `diff`：

| 退出码 | `check`                                            | `diff --policy`                                         |
| ------ | -------------------------------------------------- | ------------------------------------------------------- |
| `0`    | 编译与所有 Backend preflight 通过。                | 比较完成，且没有未豁免的 error 级 finding。             |
| `1`    | 存在 Compiler/Backend Diagnostic 或 CLI 用法非法。 | 完整比较存在未豁免 policy finding，或 CLI 用法非法。    |
| `2`    | 普通编译 Diagnostic 不使用该退出码。               | acquisition、policy、Snapshot、配置或 coverage 不完整。 |

退出码 `2` 优先于 policy failure，因为此时 CI 没有足够证据形成结论。`check` 与 `diff` 都是只读操作：它们
会校验 Backend plan，但不会 emit 配置的产物。

## 选择稳定 baseline

- Pull Request：使用 GitHub 提供的不可变 `github.event.pull_request.base.sha`。
- 分支 Push：使用上一次成功检查的 commit 或不可变 release tag。
- 本地检查：使用 `HEAD~1`、merge base，或 CI 使用的准确 commit。

需要复现报告时不要使用会移动的 branch 名。`tokenc diff` 直接读取两侧 Git object，不会 checkout。

baseline object 必须存在于本地。GitHub Actions 应将 `actions/checkout` 的 `fetch-depth` 设为 `0`；其他
CI 系统应在运行 tokenc 前 fetch 准确 baseline SHA。缺少 revision 会产生 incomplete comparison 并返回
`2`，不能把它转换成通过。

tokenc 不会隐式执行历史 revision 中的可执行配置。显式传入 `--config tokenc.config.ts` 表示两侧共同使用
当前已经审查的配置；不传时，两侧配置必须字节一致，否则比较为 incomplete。

## 报告与保留

使用完全相同的语义参数生成各格式：

```bash
mkdir -p artifacts/tokenc
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format text > artifacts/tokenc/report.txt
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json > artifacts/tokenc/report.json
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format sarif > artifacts/tokenc/report.sarif
```

所有格式都投影自同一份不可变 Report v1 entry，因此 JSON 的
`diagnostics[].diagnostic.fingerprint`、text fingerprint 与 SARIF
`partialFingerprints["tokenc/v1"]` 保持一致。应同时保留 text、JSON 与 SARIF，使失败任务可审计；参考
workflow 的保留时间为 14 天。

## Fork Pull Request 与权限

对不受信任的变更使用 `pull_request`，不要使用 `pull_request_target`。参考任务不需要 npm credential 或
repository secret，初始权限只有 `contents: read`。GitHub 会降低 fork Pull Request 的 token 权限；这些
任务仍会编译、比较并上传可下载的报告 artifact。由于 code scanning 需要 `security-events: write`，fork
场景会跳过 SARIF 上传；同仓库 Pull Request 与手动运行会把同一 SARIF 文件上传到 code scanning。

所有 Action 都固定到完整 commit SHA。只应在检查对应 Action release 并把 major tag 解析到准确 commit 后
更新 pin。

## 与现有生成器共存

保持原有生成职责不变：在独立步骤运行现有生成器，然后把 tokenc 作为 checking layer：

```bash
vp run generate-tokens
vp exec tokenc check --format text
vp exec tokenc diff --base "$TOKENC_BASE" --head HEAD --config tokenc.config.ts --policy tokenc.policy.json --format json
```

让 `tokenc.config.ts` 指向规范 DTCG 输入，而不是生成后的 CSS 或 TypeScript。`check` 会在不写文件的前提下
校验类型、引用、Context、symbol 与 output path；无论生产产物是否由其他工具生成，`diff` 都独立报告
source 的语义变化。

可执行 fixture 位于
[`packages/cli/test/fixtures/ci-repository`](../packages/cli/test/fixtures/ci-repository)，覆盖通过、breaking
policy failure、compiler failure 与 incomplete comparison。对应测试还证明 text、JSON、SARIF 的退出码与
fingerprint 一致。

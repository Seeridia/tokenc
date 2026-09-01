# M1 公共 API 稳定边界

[English](M1-API-STABILITY.md)

M1 直接替换 M1 之前的可变编译器接口。项目仍处于 `0.x`，因此这里定义的是明确的稳定边界，而不是对
未来所有 minor release 的语义版本兼容承诺。

## 支持的入口

只有 package manifest 中声明的 export 属于公共 API。Core 包括：

- `@tokenc/core`
- `@tokenc/core/diagnostic-v1.schema.json`
- `@tokenc/core/explain-trace-v1.schema.json`
- `@tokenc/core/snapshot-diff-v1.schema.json`
- `@tokenc/core/impact-report-v1.schema.json`

指向 `src/`、生成 chunk 或未列出 package path 的 deep import 都是 internal。`TokenGraph`、
`TokenResolver`、checker function、Snapshot builder、cache object 和可变 build state 均不是公共构造或
消费边界。

M1 的稳定工作流如下：

```ts
import { css } from "@tokenc/backend-css";
import { createCompilerSession, parseTokenId } from "@tokenc/core";

const tokenJson = JSON.stringify({
  spacing: { $type: "dimension", $value: { value: 16, unit: "px" } },
});
const session = createCompilerSession({
  config: {
    contexts: { theme: { default: "light", values: ["light", "dark"] } },
  },
});

const snapshot = await session.apply({
  documents: [
    {
      kind: "add",
      document: { identity: "tokens.json", content: tokenJson },
    },
  ],
});

if (snapshot.status === "valid") {
  const context = snapshot.query.context({ theme: "dark" });
  const trace = snapshot.query.explain(parseTokenId("spacing"), context);
  const emission = await snapshot.emit([css({ output: "dist/tokens.css" })]);
}

await session.close();
```

`compile()` 保留为创建临时 Session 的一次性便利入口；长生命周期工具使用 `CompilerSession`。语义读取
使用 `snapshot.query`；Backend 通过 `prepare()` 消费不可变 `CompilationIR`，并且只 emit 已接受的
`BackendPlan`。

## 版本化机器契约

Diagnostic value、`ExplainTraceV1`、`SnapshotDiffV1`、`ImpactReportV1` 与 CLI `ReportV1` 使用
`schemaVersion: "1"`。Core Schema 通过 Core subpath export 发布；Report v1 由 CLI package 发布。
Query edge 与 impact 值同样携带版本 `"1"`。如果 Schema 修改会拒绝原本有效的 v1 payload，则必须发布
新的 schema version。

仓库在 `contracts/m1-public-contracts.json` 中提交所有公共 package declaration 和版本化 JSON Schema 的
SHA-256 snapshot。CI 与发布自动化会在构建后运行 `vp run check:contracts`。任何有意的公共变更都必须同时
更新代码、文档、Changeset 与 contract snapshot。

## 从 0.3 直接替换的破坏性变更

- 可变 `Compilation` 与 `CompilationResult` 由不可变 `CompilationSnapshot` 替换。
- `IncrementalCompiler` 由 `CompilerSession` 替换，不提供兼容 facade。
- 可变 Graph patch 和直接 Resolver 消费改为 internal；使用 `snapshot.query`。
- Backend 改为 capabilities + `prepare(CompilationIR) → BackendPlan → emit(plan)`。
- Diagnostic 使用 v1 fingerprint、location、related information 与结构化 fix。
- CLI JSON 使用带版本的 Diagnostic、Query 和 Trace shape，不双写旧格式。
- M2 的 `check` 与 `diff` 使用共享 Report v1 envelope 输出 text、JSON 与 SARIF。

上述 M1 前接口没有 deprecated alias 或迁移期。

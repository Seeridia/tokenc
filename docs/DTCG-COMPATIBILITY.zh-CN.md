# DTCG 2025.10 兼容性

[English](DTCG-COMPATIBILITY.md)

tokenc 明确区分严格的 `dtcg-2025.10` dialect 与向后兼容的 `tokenc` dialect。两者都会在构建依赖图前归一化为同一套强类型 Token 模型。

| 特性                                                    | 状态                          | 说明                                                                                         |
| ------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| Format `$value`、`$type`、`$description`、`$extensions` | 完整                          | 包含 Group 类型继承与结构化诊断。                                                            |
| `$deprecated`                                           | 完整                          | 保留 boolean 与 string 元数据。                                                              |
| `$root` Token                                           | 完整                          | Canonical ID 显式保留 `$root` 段。                                                           |
| 花括号 Token Alias                                      | 完整                          | 支持类型检查、循环检测、拼写建议和源码位置。                                                 |
| 属性级 JSON Pointer Alias                               | 尚未支持                      | 严格模式输出 `DTCG_UNSUPPORTED_JSON_POINTER`。                                               |
| Group `$extends`                                        | 尚未支持                      | 严格模式输出 `DTCG_UNSUPPORTED_GROUP_EXTENDS`。                                              |
| Color 类型                                              | 直接值完整支持                | 保留全部 14 种标准颜色空间、`none`、alpha、分量范围和可选 hex fallback，不在 Core 中做转换。 |
| Dimension、duration、number、font family、font weight   | 完整                          | 归一化为 Core 强类型模型。                                                                   |
| Composite Token 类型                                    | 部分                          | 当前保留 JSON-safe 值，尚未完成深层字段校验。                                                |
| Resolver Set                                            | Inline 与完整文件 Source 完整 | 保留 Source 顺序以及“后者覆盖前者”语义。                                                     |
| Resolver Modifier 与 Input                              | 完整                          | 支持默认值、大小写不敏感匹配、输入校验和显式顺序。                                           |
| Resolver 同文档引用                                     | Set/Modifier 完整             | 可诊断循环 Set 引用。                                                                        |
| Resolver Reference 同级 Override                        | 尚未支持                      | 输出稳定诊断，不会忽略本地 Override Key。                                                    |
| Resolver 外部文件引用                                   | 完整支持本地完整 JSON 文件    | 相对路径由 Compiler IO 层加载。                                                              |
| 外部 JSON Pointer / 远程 Resolver 引用                  | 尚未支持                      | 输出稳定诊断，不会静默产生错误结果。                                                         |
| tokenc Context 扩展                                     | 保持支持                      | `org.token-compiler.contexts` 归一化为强类型 Context Override，并使用确定性维度优先级。      |

## Dialect

兼容模式仍是 v0.x 默认值，可接受 `"$value": "#0052D9"` 等简写：

```ts
defineConfig({
  dialect: "tokenc",
  source: ["tokens/**/*.json"],
});
```

严格模式需要显式开启，Color 必须使用 DTCG 结构：

```ts
defineConfig({
  dialect: "dtcg-2025.10",
  source: ["tokens/**/*.json"],
  resolver: {
    source: "tokens.resolver.json",
    input: { theme: "dark" },
  },
});
```

Resolver Parser 不执行 IO。高层 Compiler Loader 负责加载相对路径文件；虚拟或远程环境可以把已解析的 Resolver Document 传给 `compileDocuments`。

一次 Compilation 对应一组 DTCG Resolver Input，这与标准 Resolution Process 一致。若要选择其他 Modifier Context，请使用新的 `resolver.input` 重新编译，或传入 `--theme dark` 等 CLI Flag。Compiler 不会物化 Modifier 的完整笛卡尔积。

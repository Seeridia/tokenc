# DTCG 2025.10 支持矩阵

[English](DTCG-SUPPORT.md)

DTCG 2025.10 是 tokenc 唯一的编译器源语言。下表如实记录当前实现范围，不代表已经完全符合 DTCG
全部规范要求。

| 功能                                                    | 状态                     | 说明                                                                                         |
| ------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------- |
| Format `$value`、`$type`、`$description`、`$extensions` | 已支持                   | 包含 Group type inheritance 与结构化诊断。                                                   |
| `$deprecated`                                           | 已支持                   | 保留 boolean 与 string 元数据。                                                              |
| `$root` Token                                           | 已支持                   | Canonical ID 保留显式 `$root` 段。                                                           |
| 花括号 Token Alias                                      | 已支持                   | 支持类型检查、环检测、建议与源码位置。                                                       |
| 属性级 JSON Pointer Alias                               | 尚未支持                 | 报告 `DTCG_UNSUPPORTED_JSON_POINTER`。                                                       |
| Group `$extends`                                        | 尚未支持                 | 报告 `DTCG_UNSUPPORTED_GROUP_EXTENDS`。                                                      |
| Color 类型                                              | 直接值已支持             | 保留全部 14 种标准颜色空间、`none`、alpha、分量范围与可选 hex fallback，不在 Core 中做转换。 |
| Dimension、Duration、Number、Font Family、Font Weight   | 已支持                   | 归一化为 Core 强类型模型。                                                                   |
| Composite Token 类型                                    | 部分支持                 | 接受 JSON-safe 值，尚未完成深层字段校验。                                                    |
| Resolver Set                                            | Inline 与文件源已支持    | 保留源顺序与后源覆盖语义。                                                                   |
| Resolver Modifier 与 Input                              | 已支持                   | 支持默认值、大小写无关匹配、输入校验与显式顺序。                                             |
| 同文档 Resolver Reference                               | Set 与 Modifier 已支持   | 可诊断循环 Set 引用。                                                                        |
| Resolver Reference sibling override                     | 尚未支持                 | 发出稳定诊断，不会静默忽略局部 override key。                                                |
| 外部 Resolver 文件引用                                  | 本地完整 JSON 文件已支持 | Compiler IO 层加载相对路径文件。                                                             |
| 外部 JSON Pointer / 远程 Resolver 引用                  | 尚未支持                 | 发出稳定诊断，不会静默产生错误结果。                                                         |
| `org.token-compiler.contexts` 扩展                      | 已支持                   | 表示一次编译内依赖运行时 Context 的值。                                                      |

## 单一源语言

配置不再选择输入语言：

```ts
defineConfig({
  source: ["tokens/**/*.json"],
});
```

`parseTokenDocument(content, source)` 始终解析 DTCG。`"$value": "#0052D9"` 这样的字符串颜色会
产生 `DTCG_INVALID_COLOR`；Color 必须使用 DTCG 结构化表示。

## Resolver 配置

```ts
defineConfig({
  source: ["tokens/**/*.json"],
  resolver: {
    source: "tokens.resolver.json",
    input: { theme: "dark", density: "compact" },
  },
});
```

Resolver Parser 不依赖 IO。高层 Compiler Loader 解析相对路径完整文件；虚拟环境可以向
`compileDocuments` 传入已经解析的 Resolver 文档。一次编译对应一个 Resolver Input，不会物化
Modifier 的完整笛卡尔积。

## Resolver 与运行时 Context

DTCG Resolver 与 `org.token-compiler.contexts` 解决不同问题：

- Resolver 在构图前，针对选定 Input 组合 Token Source。
- 带命名空间的 DTCG 扩展在一次编译内选择依赖运行时 Context 的值。

该扩展不会替代现有标准 DTCG 能力；两条路径最终都形成强类型且确定性的编译器语义。


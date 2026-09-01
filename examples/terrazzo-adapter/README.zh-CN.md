# Terrazzo bundled-DTCG Adapter 示例

[English](README.md)

这个私有且不会发布的 workspace 展示 Terrazzo 与 tokenc 之间的窄互操作边界。Terrazzo 继续负责加载
source、运行 plugin 与 transform、选择 mode，并生成一份标准 DTCG JSON bundle；Adapter 只接收已经完成
的 bundle。

```bash
vp -C examples/terrazzo-adapter run demo
```

Adapter 会：

- 把输入 JSON 放入只含一个文档的内存 `DocumentLoader`；
- 通过公开 `CompilerSession` API 提交 document request；
- 不在 Adapter 内执行文件系统或网络获取；
- 不 deep import Core，也不导入任何 Terrazzo package；
- 将未知扩展 namespace 报告为 `preserved-unsupported`，但不解释其语义。

扩展报告为 `unsupported` 不会让原本合法的 DTCG Snapshot 失效。扩展数据仍作为 Token metadata 保留，
但 tokenc 不宣称复现了该扩展的语义。报告为 `invalid` 表示 JSON 或 `$extensions` container 非法；Core
Snapshot 会独立携带规范 compiler Diagnostic。

将此示例用于生产流水线前，请阅读完整的 [Terrazzo 共存指南](../../docs/TERRAZZO.zh-CN.md)。

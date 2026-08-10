# 严格 DTCG Resolver 示例

[English](README.md)

本示例通过 DTCG 2025.10 `theme` Modifier 将 Foundation Set 与主题 Source 组合。配置选择 Dark Input，并从最终强类型 Graph 生成 CSS。

```bash
vp run build
```

可以修改 `tokenc.config.ts` 中的 `resolver.input.theme`，或在根目录 CLI 中传入 `--theme light` 来选择另一套 Resolution。

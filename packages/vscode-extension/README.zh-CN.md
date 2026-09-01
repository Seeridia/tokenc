# tokenc VS Code 扩展

[English](README.md)

这是 tokenc Design Token Compiler 的薄 VS Code 客户端。扩展负责启动 bundled
`@tokenc/language-server`；编译器解析、Graph、解析值、诊断与 rename 语义仍由共享 tokenc package
提供。

逐项功能操作、完整设置、multi-root 行为与排障见[完整指南](../../docs/VS-CODE-GUIDE.zh-CN.md)。实际可
运行的 [React 计数器](../../examples/react-counter/README.zh-CN.md)可直接作为 Extension 体验项目。

## 从本仓库安装

在仓库根目录运行：

```bash
vp install
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
```

打开包含 `tokenc.config.ts`、`.mts`、`.js` 或 `.mjs` 的目录后，扩展会自动激活。配置文件是可执行
代码，因此只有 VS Code 判定 workspace 已受信任时，tokenc 才会加载它。

## 功能

- 当前 Snapshot 的诊断与无效编辑自动恢复。
- Alias completion、definition、references、document/workspace symbols 与 Context-aware hover。
- 通过标准 LSP edit 提供 collision-safe rename 与 registry 授权的 quick fix。
- `tokenc: Restart Language Server` 与 `tokenc: Show Language Server Status` 命令。
- 在内存中选择已配置的 Context/Resolver input profile，不写入项目文件。

可在 VS Code settings 中配置默认值与命名选项：

```json
{
  "tokenc.configPath": "tokenc.config.ts",
  "tokenc.context": { "theme": "light" },
  "tokenc.resolverInput": { "brand": "default" },
  "tokenc.contextProfiles": {
    "浅色": { "theme": "light" },
    "深色": { "theme": "dark" }
  },
  "tokenc.resolverInputProfiles": {
    "默认品牌": { "brand": "default" },
    "Acme": { "brand": "acme" }
  }
}
```

运行 `tokenc: Select Context Profile` 或 `tokenc: Select Resolver Input Profile`。选择仅在当前扩展
会话中生效，并分别转发给 Language Server。修改底层 `tokenc.*` setting 后，临时选择会清除，Server
会重启。

## 故障排查

- **功能没有出现：**确认打开目录含受支持的 `tokenc.config.*`，信任 workspace，然后运行
  `tokenc: Restart Language Server`。
- **找不到配置：**将 `tokenc.configPath` 设置为相对 workspace folder 的路径。未信任 workspace 中该
  setting 会被限制。
- **解析值不符合预期：**Context 与 Resolver input 有意保持独立。先运行
  `tokenc: Show Language Server Status`，再重新选择相应 profile。
- **查看日志：**打开 **View → Output**，选择 **tokenc Language Server**。

仓库 smoke test 会构建确定性 VSIX，将其安装到临时的干净 user-data/extension 目录，激活已安装扩展，
并验证导航、诊断以及“不写源文件”保证：

```bash
vp -C packages/vscode-extension run smoke:vsix
```

Marketplace 发布与凭证明确不属于 M3 验收门槛。

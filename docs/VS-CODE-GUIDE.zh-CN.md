# tokenc VS Code Extension 完整指南

[English](VS-CODE-GUIDE.md)

本指南覆盖当前 Extension 的安装、全部编辑能力、Context/Resolver input、multi-root、信任模型与排障。
若希望边看页面边体验，直接使用 [React 计数器示例](../examples/react-counter/README.zh-CN.md)。

## 1. 安装与正确打开项目

从仓库构建并安装当前 VSIX：

```bash
vp install
vp -C packages/vscode-extension run package:vsix
code --install-extension artifacts/tokenc-vscode.vsix --force
```

`code --install-extension` 只安装扩展，不会自动打开 VS Code。可显式打开示例：

```bash
code examples/react-counter
```

扩展要求 VS Code `1.134.0` 或更高版本。打开的 workspace folder 应满足下列条件之一：

- 根目录直接包含 `tokenc.config.ts`、`.mts`、`.js` 或 `.mjs`；
- 通过 `tokenc.configPath` 指定相对 workspace folder 的配置路径。

配置文件是可执行代码。首次打开时选择 **Trust**；未受信任的 workspace 中 Extension 可以启动，但不会
执行配置，也不会加载 Token source。

## 2. 五分钟完整体验

打开 `examples/react-counter` 后，使用 `tokens/semantic.json` 和 `tokens/component.json` 依次完成：

| 能力              | 如何触发                                                            | 可观察结果                                                               |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Diagnostics       | 把 Alias 临时改为 `{missing.token}`                                 | Problems 与源码位置出现 `TOKEN_UNKNOWN_REFERENCE`；恢复后消失            |
| Completion        | 将光标放入已有的 `{canvas.background}` 内，执行 **Trigger Suggest** | 列出排序后的 canonical Token ID 与类型                                   |
| Hover             | 悬停 `{palette.slate.50}`                                           | 显示类型、选中表达式、解析值、有效 Context、来源链和相关诊断             |
| Go to Definition  | 在 Alias 上按 `F12`                                                 | 跳到跨文件 Token 声明的精确范围                                          |
| Find References   | 在声明或 Alias 上按 `Shift+F12`                                     | 列出声明、Alias、JSON Pointer、composite field 与 group inheritance 引用 |
| Document Symbols  | 打开 Explorer 的 **Outline**                                        | 按原始 Token/group 层级浏览当前文档                                      |
| Workspace Symbols | `Cmd+T` / `Ctrl+T`                                                  | 按 canonical ID 搜索整个 workspace 的 Token                              |
| Rename            | 在 `surface.muted` 上按 `F2`，输入完整 ID `surface.subtle`          | 原子更新声明和所有 Token 引用；冲突时拒绝整次操作                        |
| Quick Fix         | 在带灯泡且包含可应用 fix 的 tokenc 诊断上按 `Cmd+.` / `Ctrl+.`      | 返回带版本保护的 workspace edit；安全修复优先                            |
| Context profile   | 命令面板运行 **tokenc: Select Context Profile** → **Dark**          | 后续 Hover 使用 dark Context，不写项目文件                               |
| Status            | 运行 **tokenc: Show Language Server Status**                        | 显示 Server lifecycle 和 workspace trust 状态                            |
| Restart           | 运行 **tokenc: Restart Language Server**                            | 串行停止旧 Server 并启动新实例                                           |

Completion 只在编译器确认属于 Token Alias 的范围内出现，不会污染普通 JSON 字符串。Quick Fix 也只在
当前诊断携带、且 Diagnostic registry 允许相应 fix 时出现；不是每类错误都有自动修复。

## 3. 功能细节

### Diagnostics 与无效编辑恢复

Extension 使用打开编辑器中的内存内容，而不是等待文件落盘。每次变化形成新的 workspace revision，只有
最新 revision 的结果可以发布，因此快速输入时不会被旧诊断覆盖。

- JSON 语法、DTCG 结构、类型、引用、Context、循环与 Backend preflight 问题都会显示在 Problems。
- 诊断包含稳定 code、UTF-16 精确范围、关联位置、文档链接和 fingerprint。
- 文件临时处于非法状态时，只展示当前 snapshot 能证明的信息；恢复后重新得到完整图。
- 编译失败不会产生部分输出；Extension 本身也不会写生成物。

### Completion、Hover 与导航

- **Completion**：仅补全 canonical Token ID，结果确定性排序，并显示 Token 类型。
- **Hover**：可在声明与引用上查看 selected expression、resolved value、effective Context 和 explain
  provenance。切换 Context profile 后再次 Hover 即可比较值。
- **Definition**：支持 Alias、JSON Pointer、composite field reference 与 `$extends` group inheritance。
- **References**：基于当前条件依赖图，Context 改变时可能得到不同的有效引用集合。
- **Symbols**：Document Symbols 保留 group 层级；Workspace Symbols 支持跨 source 搜索。

这些能力只作用于 `tokenc.config.*` 的 `source` 匹配到的 JSON/JSONC 文件；生成的 CSS/TypeScript 不是
Token 源图的一部分。

### Rename

Rename 使用 Core 的 atomic rename planner，而不是文本替换：

1. 同时计划声明和所有已知引用的改动；
2. 在虚拟编译中检查 duplicate ID、类型和 Backend symbol collision；
3. 确认 source digest、打开文档版本和 workspace revision 未变化；
4. 全部通过后才向 VS Code 返回一个 versioned `documentChanges` edit。

输入的是完整 canonical ID，例如将 `surface.muted` 改为 `surface.subtle`，不是只输入叶节点
`subtle`。生成的 CSS/TypeScript 不会被 Rename 直接修改；随后运行 `tokenc build` 重新生成。

### Quick Fix

Code Action 只接受来源为 `tokenc`、fingerprint 与当前 snapshot 一致、并由 Diagnostic registry 授权的
修复。过期、越界、重叠或 source ownership 不匹配的 edit 会被丢弃。`safe` 修复标记为 preferred，
`requires-review` 修复仍可选择但不会优先。

### Context profile

普通 Context 用于查询同一次 compilation 中的条件值。配置默认值和命名 profile：

```json
{
  "tokenc.context": { "theme": "light" },
  "tokenc.contextProfiles": {
    "Light": { "theme": "light" },
    "Dark": { "theme": "dark" }
  }
}
```

运行 **tokenc: Select Context Profile** 选择 profile。临时选择只存在于当前 Extension 会话并立即用于
Hover/References 等查询，不修改 Token、配置或生成物。选择 **Configured default** 可回到
`tokenc.context`。

### Resolver input profile

Resolver input 选择 DTCG Resolver 的 source composition；它和普通 Context 是两条独立通道：

```json
{
  "tokenc.resolverInput": { "brand": "default" },
  "tokenc.resolverInputProfiles": {
    "Default brand": { "brand": "default" },
    "Acme": { "brand": "acme" }
  }
}
```

运行 **tokenc: Select Resolver Input Profile**。Resolver input 会事务性更新 Session source；普通 Context
只改变查询视角。两者都不会写项目文件。

## 4. 所有设置

设置可写入 `.vscode/settings.json`，并可按 workspace folder 配置：

| 设置                           | 默认值 | 用途                                             |
| ------------------------------ | ------ | ------------------------------------------------ |
| `tokenc.configPath`            | `""`   | 相对当前 workspace folder 的可选配置路径         |
| `tokenc.context`               | `{}`   | 默认普通 Context selection                       |
| `tokenc.resolverInput`         | `{}`   | 默认 Resolver input                              |
| `tokenc.contextProfiles`       | `{}`   | **Select Context Profile** 显示的命名映射        |
| `tokenc.resolverInputProfiles` | `{}`   | **Select Resolver Input Profile** 显示的命名映射 |

修改任意 `tokenc.*` 设置后，Extension 会清除会话内临时 profile 并重启 Server，以配置值为准。

## 5. Multi-root workspace

每个 workspace folder 拥有独立配置、Compiler Session、Context 和 Resolver input。推荐在各目录自己的
`.vscode/settings.json` 中设置 `tokenc.configPath` 和 profile；也可以在 VS Code Settings UI 中先选择
目标 folder，再修改 Workspace Folder scope。

执行 profile 命令时：

- 当前 editor 属于某个 folder，则直接作用于该 folder；
- 只有一个 folder，则自动选择它；
- 多个 folder 且没有可判定的 active editor，则显示 folder picker。

不同 folder 的诊断和查询互相隔离，动态添加或移除 workspace folder 也会建立或关闭相应 Session。

## 6. 生命周期与安全边界

- Extension 仅为 thin client；Parser、Graph、Resolver、Diagnostics 与 Rename 语义来自共享 tokenc
  package。
- Client 监听 JSON/JSONC、Token source 与 `tokenc.config.*` 变化，通过标准 LSP 与 bundled Server
  通信。
- 配置执行 fail-closed：只有 VS Code 报告 workspace trusted 时才加载。
- Restart 被串行化，不会留下两个同时运行的 Server。
- Extension 不运行 `tokenc build`，也不写 source；输出生成仍由 CLI 明确执行。

## 7. 排障

### 安装成功但没有自动打开

这是预期行为。安装与打开窗口是两个动作：

```bash
code --install-extension artifacts/tokenc-vscode.vsix --force
code examples/react-counter
```

### 没有 Hover、补全或诊断

1. 确认当前文件是配置 `source` 匹配的 JSON/JSONC；
2. 确认打开的是含配置的 folder，而不是它的无配置父目录；
3. 若配置在子目录，设置例如
   `"tokenc.configPath": "examples/react-counter/tokenc.config.ts"`；
4. 确认 workspace 已信任；
5. 运行 **tokenc: Show Language Server Status**，再运行 **Restart Language Server**。

### Context 值不符合预期

确认操作的是 **Context Profile** 还是 **Resolver Input Profile**。修改 settings 会清除此前的临时选择。
重新选择 profile，再 Hover 同一个 Token 对比 `context` 和 `resolvedValue`。

### 查看日志

打开 **View → Output**，在下拉框选择 **tokenc Language Server**。配置加载失败、workspace 名称与
snapshot 状态会写入这里。

### 验证 VSIX 本身

仓库 smoke 会打包 VSIX、安装到临时的干净 VS Code profile、激活扩展，并验证导航、诊断和不写 source：

```bash
vp -C packages/vscode-extension run smoke:vsix
```

## 8. 当前边界

- 只为 file scheme 的 JSON/JSONC Token source 注册语言能力。
- 配置必须是受信任 workspace 中的本地可执行 `tokenc.config.*`。
- Profile selection 只保持到当前 Extension 会话结束。
- Extension 不负责运行构建、预览生成 CSS/TS 或发布 package。
- Marketplace 发布与凭证不属于当前仓库验收范围；本地 VSIX 是完整验证路径。

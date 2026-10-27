# 贡献指南 · Contributing to DSH Project Hub

先说结论：**这个项目欢迎任何规模的贡献**——错别字、文档、Bug 修复、新功能都可以。

---

## 🐛 报 Bug / 提需求

请先搜一遍 [Issues](https://github.com/systemsssx/dsh-project-hub/issues) 和 [Discussions](https://github.com/systemsssx/dsh-project-hub/discussions)，避免重复。

- **Bug** → 用 [Bug Report 模板](https://github.com/systemsssx/dsh-project-hub/issues/new?template=bug_report.md)，把「复现步骤 / 期望 / 实际 / DSH 版本 / OS」写全。
- **需求** → 用 [Feature Request 模板](https://github.com/systemsssx/dsh-project-hub/issues/new?template=feature_request.md)，重点说清楚**使用场景**和**现在卡在哪**。
- **用法讨论** → 去 [Discussions](https://github.com/systemsssx/dsh-project-hub/discussions)，不走 Issue。

> 发帖前请把真实绝对路径、用户名、token 换成 `<总工作区>`、`<项目>` 之类的占位。

---

## 🛠️ 提 PR

1. 先开 Issue 对齐方向（避免写完才发现方向不一致）。
2. Fork → 开分支 → 改代码：

   ```bash
   git checkout -b feat/small-tag-autocreate
   ```

3. 提交前跑通：

   ```bash
   npm test        # node --test test/*.mjs，必须全绿
   npm run check   # 语法自检
   ```

4. 提 PR 时附上：**改了什么、为什么、`npm test` 输出**。UI 相关改动请配截图/动图。

### 代码风格

- **纯 ESM、零运行时依赖**：不新增 `dependencies`；能用 Node 内置模块就别引包。
- **界面在 `lib/client.js`**：不写 JSX，统一 `React.createElement`；不要自己 `import React`，用宿主共享实例。
- **磁盘只在宿主侧**：`lib/index.js`（宿主）可以 `node:fs`；`lib/client.js` 一律走 HTTP 路由。
- **档案写入默认 append**：不要悄悄改成覆盖；需要覆盖必须显式传 `mode: 'overwrite'`。
- **注释解释"为什么"**，而不是重复"做了什么"。
- 中文文案保持口语化、短句；错误提示必须能指导用户下一步。
- 提交信息用 Conventional Commits：`feat:` / `fix:` / `docs:` / `test:` / `refactor:`。

### 测试要求

| 改动类型 | 至少补的测试 |
|---|---|
| `lib/doc-manager.js` | `test/run.mjs`：花名册 / 子工作区 / 档案追加 |
| 宿主路由 | `test/integration.mjs` 或 `test/settings-host.mjs` |
| 界面交互 | `test/ingest-*.mjs` / `test/settings-ui.mjs` 风格（假 DOM + 纯 props 断言） |
| 主题 token | `test/theme-tokens.mjs` 会校验每个 `--dsw-*` 是否真实存在 |

测试数据只允许写在 `test/.tmp-*`，**禁止读写用户真实总工作区**。

---

## 📄 License

提交即表示你同意以 [MIT License](./LICENSE) 授权你的贡献。

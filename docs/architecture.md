# 🏗️ 架构说明 · dsh-project-hub

> 这份文档解释插件**为什么这么设计**，不是 API 手册。想快速上手看 [README](../README.md) 即可。

## 一句话

界面在浏览器侧，磁盘在宿主侧，中间用本地 HTTP 连起来；档案是 Markdown，档案柜是两级标签目录。

```text
lib/client.js（界面）── HTTP JSON ──▶ lib/index.js（宿主）──▶ lib/doc-manager.js ──▶ 磁盘
                                          ▲
                        lib/completion-gate.js 守在归档口：record_module_done → 写档案
```

## 两半结构：为什么不能只有一个文件

| 半边 | 文件 | 能力 | 限制 |
|---|---|---|---|
| 浏览器侧 | `lib/client.js` | 渲染抽屉 / 弹窗 / 表单 | 不能碰 `node:fs`、不能读本机路径 |
| 宿主侧 | `lib/index.js` + `doc-manager.js` + `completion-gate.js` | 读写文件、启动会话、注册 Agent 工具 | 无 DOM，界面靠 client 渲染 |

这是 DSH 插件体系的硬边界：client bundle 被宿主当普通脚本注入页面，运行在 Chromium 沙箱里；只有 Cordis 插件实例（Host）拥有 Node 能力。
所以插件把**所有磁盘操作**放在 Host，界面只负责发请求——"前台不能进档案室，只能递条子"。

为什么用 HTTP 而不是 IPC：宿主本来就带本地 `webServer`，`register({ kind: 'exact', path, handler })` 挂 8 条路由是最轻的扩展方式；
标准 HTTP 还让同一份代码在 Electron 桌面壳和普通网页（`dsh web`）里都能跑通。

## 8 条路由

| 方法 | 路径 | 输入要点 | 输出要点 |
|---|---|---|---|
| GET | `/project-hub/state` | — | 项目树、两级标签档案计数、当前总工作区、可用 Agent 模式 |
| GET | `/project-hub/sessions` | — | 可归档的历史会话（含 cwd、标题、时间） |
| POST | `/project-hub/create-project` | `id` / `name` / `defaultTags` | 建目录 + 写花名册记录 |
| POST | `/project-hub/launch-session` | `projectId` / `selectedSmallTags` / `mode` | 新会话 id、物理 cwd、注入的背景 |
| POST | `/project-hub/create-doc` | `projectId` / `bigTag` / `smallTag` | 只创建，不覆盖（同名 → `doc_exists`） |
| POST | `/project-hub/ingest-history` | 会话列表 + 摘要/细节/涉及文件 | 写入（默认追加）档案 |
| POST | `/project-hub/remove-project` | `projectId` | **仅**移出注册表 |
| GET / POST | `/project-hub/settings` | `globalWorkspaceRoot`（POST） | 当前值 / 校验并热切换 |

所有路由都包了一层 `route()`：处理 CORS、Private Network Access 预检，并保证响应**一定** settle（不会挂死客户端）。

## 数据契约

### 花名册 `<总工作区>/.dsh-hub/projects.json`

```json
[
  {
    "id": "my-project",
    "name": "我的项目",
    "path": "<总工作区>/my-project",
    "defaultTags": ["UI组件", "Core算法"]
  }
]
```

### 档案 `<项目>/.dsh-hub/docs/<大标签>/<小标签>.md`

frontmatter 是**给程序读的索引**，不是装饰：

| 字段 | 用途 |
|---|---|
| `project_id` / `project_name` | 归档时回填、展示 |
| `big_tag` / `small_tag` | 稳定性校验（大小写不同视为同名） |
| `workspace_path` | 原始物理工作区绝对路径，注入背景与回溯都靠它 |
| `last_updated` | 侧边栏排序 / 最近更新时间 |
| `session_id` | 归档来源会话 |
| `status` | 当前固定 `completed` |

正文固定五段：核心目标 / 实现细节 / 涉及文件 / 验证方式 / 下一步。

### 追加语义（v0.2.0 重点）

```text
writeTagDoc(..., mode='append')  ← 默认
  ├─ 文件不存在 → 用五段模板新建
  └─ 文件已存在 → 原文 100% 保留
                  ├─ 只把 frontmatter 的 last_updated 换成本次时间
                  └─ 文末追加 "## 追加记录（YYYY-MM-DD HH:mm）" + 本次摘要/细节/涉及文件
writeTagDoc(..., mode='overwrite')  ← 仅显式调用；会重写正文（谨慎）
writeTagDoc(..., mode='create')     ← 仅新建；已存在则抛 doc_exists（供「＋新建小标签」用）
```

## 三层子工作区

| 勾选的小标签数 | cwd | 语义 |
|---|---|---|
| 0 | `<项目>/` | 项目级任务 |
| 1 | `<项目>/subtasks/<小标签>/` | 单个模块 |
| 2+ | `<项目>/subtasks/combo-<标签>-<标签>/` | 跨模块复合任务 |

cwd 就是 AI 的上下文边界：物理隔离 = 上下文隔离。目录在启动时按需创建。

## 归档闸门：completion-gate

`record_module_done` 是给模型用的工具，但**不是**模型说了算：
`isGenuineTaskCompletion()` 要求「本轮正常结束」且「本轮确实写过文件或跑过命令」才放行，
空手（只有对话没有产出）的调用会被拒绝——避免 AI 写出一堆没发生过的"已完成"。

`POST /project-hub/ingest-history` 是手动归档通道：用户可以勾选历史会话，人工确认后再入库。

## 总工作区的三级解析

1. `config.globalWorkspaceRoot`（`cordis.patch.yml`，标注为部署时默认值）
2. `DSH_PROJECT_HUB_ROOT` 环境变量
3. 兜底 `C:\work`

运行期一旦在「设置」里保存过，`<pluginRoot>/config.json` 里的持久值优先；保存失败/非法值一律 400 且不突变任何状态。
`config.json` 含本机路径，已在 `.gitignore` 中排除，**不会入库**。

## Agent 模式：标准 / Computer Use

- `standard` → 宿主自带的编码 preset。
- `computer-use` → 由外部 bundle（如 `dsh-orb`）提供的 GUI 驱动 preset；**解析不到就自动隐藏**，不报错。
- 任何从项目工坊启动的会话都 pin 在 `danger-full-access` preset（完全权限、审批 never）——这是能力也是风险，README 里已明确标注。
- 插件不绕过宿主的 sandbox/approval，只是为"新会话"指定预设。

## 测试策略

- 纯 Node 测试（`node --test`），不需要 GUI。
- 假 DOM：client 侧测试用极简 `createElement` 假实现，只断言 **props / aria / 文案**，不断言渲染细节。
- 真实 Host 路由：直接在 Node 里 `apply()` 一个假 ctx，起 `http` 服务器打真实请求。
- 主题 token：`test/dsw-token-manifest.json` 是从 app.asar 扫描出的真实 `--dsw-*` 清单，保证注入的 CSS 变量不会凭空捏造。
- 全部测试数据写在 `test/.tmp-*`，不碰用户真实总工作区。

## 兼容性注意

- 纯 ESM（`"type": "module"`），Node >= 18。
- 平台差异全部走 `node:path`；默认总工作区是 Windows 习惯路径，**首装必须改成自己的绝对路径**。
- 若宿主缺少 `agentPresets` 扩展点：`state` 只报「标准模式」，路由仍可用。

# StarMark

> 统一搜索 GitHub Stars 与浏览器书签的本地搜索入口 —— 像查书签一样快，一句话找到 Star 过的项目。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 简介

StarMark 是一款面向 Chrome/Edge（Manifest V3）的浏览器扩展。它将你的 **GitHub Stars** 和 **浏览器书签** 整合到同一个本地搜索入口，侧边栏 / 地址栏输入关键词即可同时检索两类内容，结果按来源分组展示，数据 100% 存在本地。

针对"Stars 只进不出、找项目靠翻页"和"书签与 Stars 是两个孤岛"的痛点设计。它只做一件事：**查找**。

## 功能特性

- **统一搜索**：侧边栏搜索框 + 地址栏 `st` 关键字，书签与 Stars 混排分组展示
- **本地索引**：MiniSearch 全文索引（前缀 + 模糊匹配 + 字段加权），构建/查询在 Web Worker 中进行，不阻塞 UI
- **优质中文支持**：按整串 + 单字 + 相邻二元组分词，中文标题子串可命中
- **收藏夹树**：未搜索时展示书签文件夹树 + 「⭐ 全部 Star 项目」特殊目录，移动/改名即时回溯真实路径
- **AI 整理标签**：接入你自己的 LLM（本地 Ollama 或云端 OpenAI 兼容 / Anthropic），50 条/批自动分组全部条目、按组预览与应用；支持**暂停 / 继续 / 断点续跑**，优先复用现有标签避免碎片化
- **规则自动标签**：按域名 / URL / 标题 / 语言配置标签规则，新条目即时命中
- **批量操作与导出**：多选加标签 / 隐藏 / 删除，导出 Markdown / HTML（Netscape）/ CSV
- **热榜推荐**：抓取 github.com/trending（日 / 周 / 月），一键 Star 或存书签，本地按日缓存
- **多语言界面**：内置简体中文 / 日本語 / English，词典外置于 `core/locales/*.json`
- **自动同步**：GitHub Stars 定时同步（默认 6h，ETag 增量），书签变更事件增量同步，全部可恢复、幂等
- **去重合并**：同一条内容的 http/https、www 变体自动归一合并（GitHub 域强制 https），同时显示 Star / 书签双来源标记
- **三种外观主题**：跟随系统 / 浅色 / 深色
- **隐私安全**：PAT 仅存 `chrome.storage.local`，无任何服务器调用，可一键清除数据

## 工作原理

```
浏览器书签 ──▶ chrome.bookmarks API ──┐
                                      ├──▶ Dexie (IndexedDB) ──▶ MiniSearch Worker ──▶ 侧边栏/地址栏搜索
GitHub Stars ──▶ GitHub REST API (PAT)─┘    (本地唯一数据源)
```

- **Stars**：使用 GitHub `GET /user/starred` + `Accept: application/vnd.github.star+json` 分页拉取（含 `starred_at`），带条件请求（ETag 仅认第一页指纹），未变化时 304 零成本跳过；断点续跑的状态机应对 MV3 Service Worker 随时终止的问题。
- **书签**：安装时 + 启动时全量遍历一次（一次 `getTree` 调用直读完整树，批量入库），之后订阅 `onCreated/onRemoved/onChanged/onMoved` 事件增量更新，1s 节流批量写入，即时回溯真实目录路径。
- **长任务架构**：AI 整理 / 同步 / 书签遍历等长任务一律「同步落盘运行状态 → 立即返回 → 后台循环 + 检查点」，UI 轮询进度；AI 请求带心跳保活与 AbortSignal（暂停即切断模型推理）；条目主键为 128-bit 哈希，URL 变体自动归一合并。

详细说明见 [`docs/开发技术文档.md`](docs/开发技术文档.md) 与 [`docs/产品设想.md`](docs/产品设想.md)。

## 安装（开发者模式）

需要 Chrome/Edge ≥ 116。

```bash
npm install
npm run dev        # 开发模式（HMR + 快速重载），或
npm run build      # 生产构建，产物在 .output/chrome-mv3
```

然后在浏览器中：

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3` 目录

## 使用

| 场景 | 操作 |
|------|------|
| 搜某个项目 | 点击工具栏图标打开侧边栏直接输入；或在地址栏输入 `st <关键词>` |
| 启用 Stars | 侧边栏「设置」→ 粘贴 GitHub PAT 并「保存」→ 或直接点「同步」 |
| 查看全部 Star | 侧边栏未输入时展开「⭐ 全部 Star 项目」 |
| AI 整理标签 | 设置页「AI 整理标签」→ 选择 Provider（Ollama 本地 / OpenAI 兼容 / Anthropic）→「开始 AI 整理」→ 实时进度，可暂停/继续，完成后按标签组预览并应用 |
| 规则自动标签 | 设置页「规则自动标签」面板配置规则，新条目即时命中 |
| 批量操作 / 导出 | 侧边栏「☑ 多选」→ 加标签 / 隐藏 / 删除；「⇩ 导出」全库或所选为 Markdown / HTML / CSV |
| 热榜推荐 | 侧边栏「热榜」页签，日 / 周 / 月切换，一键 Star 或存书签 |
| 定时同步 | 设置页调整同步频率（默认 6 小时） |
| 深色/浅色 | 设置页「外观主题」选择跟随系统 / 浅色 / 深色 |
| 界面语言 | 设置页语言下拉可切换简体中文 / 日本語 / English（默认跟随浏览器语言） |

### 创建 GitHub Token

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens
2. 生成 token，仓库访问选择「All repositories」或指定仓库，权限勾选 **Starring: Read**（如需"书签 → Star"一键互转，勾选 **Starring: Write**）
3. 将 token 粘贴到 StarMark 设置页

> Token 仅保存在本机 `chrome.storage.local`，不通过任何服务器中转；请勿将其提交到公开仓库。
>
> **隐私说明**：GitHub Token 与全部书签/Star 数据均只保存在本机（`chrome.storage.local` 与 IndexedDB），不会上传到任何服务器；联网请求仅直达 `api.github.com`（同步 Star 列表）、`github.com/trending`（热榜）与 favicon 图标服务，导出的备份文件完全由你自行保管。选**本地 Ollama** 模式时，AI 整理的数据同样不出本机；选云端 Provider 时条目标题/描述会发往你自配的服务商。

### 接入本地 Ollama

1. 安装并启动 Ollama（`ollama serve`），`ollama pull <模型>` 拉取模型
2. 设置页 Provider 选 **Ollama（本地模型）**，端点默认 `http://127.0.0.1:11434`，点「测试连接」列出本地模型
3. 若提示 403（Ollama ≥0.1.47 的来源白名单），重启 Ollama 前设置环境变量 `OLLAMA_ORIGINS="*"` 即可——扩展已默认尝试自动放行，通常无需此步

## 技术栈

WXT · TypeScript · React · Dexie (IndexedDB) · MiniSearch · Vitest

## 项目结构

```
StarMark/
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts       # Service Worker：同步作业、书签事件、omnibox、alarms、消息路由表
│  │  ├─ sidepanel/          # 侧边栏页面（React，components/ 拆分）+ search-worker.ts（MiniSearch Worker）
│  │  └─ options/            # 设置页（PAT、AI 整理、规则、同步频率、主题、数据管理）
│  ├─ core/
│  │  ├─ ai/                 # LLM Provider（Ollama/OpenAI/Anthropic）、建议流水线、批量分类
│  │  ├─ locales/            # 三语词典（zh-CN / ja / en）
│  │  ├─ api/                # GitHub REST 客户端
│  │  ├─ sync/               # Stars 同步状态机 + 书签同步
│  │  ├─ search/             # MiniSearch 索引配置、排序选择器、Worker 消息协议
│  │  ├─ i18n.ts             # 轻量国际化逻辑（词典见 locales/）
│  │  ├─ db.ts               # Dexie 定义（v1–v6 迁移）、条目/计数/批量操作
│  │  └─ trending.ts         # 热榜抓取解析 + 日缓存
├─ docs/                     # 产品设想、开发技术文档、代码审查报告、阶段工作文档
├─ public/
│  ├─ _locales/              # 扩展清单本地化（名称 / 描述，zh_CN / ja / en）
│  └─ icons/                 # 图标
├─ wxt.config.ts
└─ package.json
```

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式（Chrome MV3） |
| `npm run build` | 生产构建到 `.output/chrome-mv3` |
| `npm test` | Vitest 单元测试（123 项） |
| `npm run compile` | `tsc --noEmit` 类型检查 |
| `npm run zip` | 产出商店 zip |
| `npm run gen:icons` | 重新生成扩展图标 |

## Roadmap

- [x] Phase 2：AI 整理标签（Ollama 本地 / 云端 BYOK，批量分组 + 暂停续跑）
- [ ] Phase 2.5：仅对无标签条目的增量补标（逐条建议流水线已实现，待重新提供入口）
- [ ] Phase 3：语义 / 向量搜索（`embedded` 字段已预留）
- [ ] Phase 4：跨设备同步
- [ ] Phase 5：Firefox 适配

## License

[MIT](LICENSE)
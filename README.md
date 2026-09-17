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
- **收藏夹树**：未搜索时展示书签文件夹树 + 「⭐ 全部 Star 项目」特殊目录
- **多语言界面**：内置简体中文 / 日本語 / English，侧边栏与设置页全量翻译，设置页可随时切换
- **自动同步**：GitHub Stars 定时同步（默认 6h），书签变更事件增量同步，全部可恢复、幂等
- **去重合并**：同一 URL 既被 Star 又被收藏时合并为一行，同时显示两种来源标记
- **三种外观主题**：跟随系统 / 浅色 / 深色
- **隐私安全**：PAT 仅存 `chrome.storage.local`，无任何服务器调用，可一键清除数据

## 工作原理

```
浏览器书签 ──▶ chrome.bookmarks API ──┐
                                      ├──▶ Dexie (IndexedDB) ──▶ MiniSearch Worker ──▶ 侧边栏/地址栏搜索
GitHub Stars ──▶ GitHub REST API (PAT)─┘    (本地唯一数据源)
```

- **Stars**：使用 GitHub `GET /user/starred` + `Accept: application/vnd.github.star+json` 分页拉取（含 `starred_at`），带条件请求（ETag），未变化时 304 零成本跳过；断点续跑的状态机应对 MV3 Service Worker 随时终止的问题。
- **书签**：安装时 + 启动时全量遍历一次，之后订阅 `onCreated/onRemoved/onChanged/onMoved` 事件增量更新，1s 节流批量写入。
- **后台**：Background Service Worker 不持有长驻内存，一切状态落库，写的每页都持久化检查点。

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
| 定时同步 | 设置页调整同步频率（默认 6 小时） |
| 深色/浅色 | 设置页「外观主题」选择跟随系统 / 浅色 / 深色 |
| 界面语言 | 设置页语言下拉可切换简体中文 / 日本語 / English（默认跟随浏览器语言） |

### 创建 GitHub Token

1. GitHub → Settings → Developer settings → Fine-grained personal access tokens
2. 生成 token，仓库访问选择「All repositories」或指定仓库，权限勾选 **Starring: Read**
3. 将 token 粘贴到 StarMark 设置页

> Token 仅保存在本机 `chrome.storage.local`，不通过任何服务器中转；请勿将其提交到公开仓库。
>
> **隐私说明**：GitHub Token 与全部书签/Star 数据均只保存在本机（`chrome.storage.local` 与 IndexedDB），不会上传到任何服务器；联网请求仅直达 `api.github.com`（同步 Star 列表）与 favicon 图标服务，导出的备份文件完全由你自行保管。

## 技术栈

WXT · TypeScript · React · Dexie (IndexedDB) · MiniSearch · Vitest

## 项目结构

```
StarMark/
├─ src/
│  ├─ entrypoints/
│  │  ├─ background.ts       # Service Worker：同步作业、书签事件、omnibox、alarms
│  │  ├─ sidepanel/          # 侧边栏页面（React）+ search-worker.ts（MiniSearch Worker）
│  │  └─ options/            # 设置页（PAT 配置、同步频率、主题、数据管理）
│  ├─ core/
│  │  ├─ i18n.ts             # 轻量国际化字典（zh-CN / ja / en）与翻译函数
│  │  ├─ api/                # GitHub REST 客户端
│  │  ├─ sync/               # Stars 同步状态机 + 书签同步
│  │  └─ search/             # MiniSearch 索引配置、Worker 消息协议
├─ docs/                     # 产品设想、开发技术文档
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
| `npm test` | Vitest 单元测试 |
| `npm run compile` | `tsc --noEmit` 类型检查 |
| `npm run zip` | 产出商店 zip |
| `npm run gen:icons` | 重新生成扩展图标 |

## Roadmap

- [ ] Phase 2：AI 分类 / 标签 / 收藏理由备注
- [ ] Phase 3：语义 / 向量搜索
- [ ] Phase 4：跨设备同步
- [ ] Phase 5：Firefox 适配

## License

[MIT](LICENSE)
<div align="center">

<img src="assets/logo.png" alt="dsh-tree-view" width="150" />

# dsh-tree-view

**一个对话 = 一棵树 = 侧栏一个入口**

在 DeepSeek Harness 里以树形视图使用会话：编辑一条旧消息，对话从那一刻重新分叉，而**所有分支住进同一棵树** —— 侧栏里永远只占一个位置。

[![License: MIT](https://img.shields.io/badge/License-MIT-2f7de1.svg)](./LICENSE)
[![Platform: DSH web](https://img.shields.io/badge/platform-DSH%20web-334eac.svg)](#兼容性)
[![DSH: 0.1.5-rc.2](https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff.svg)](#兼容性)
[![PRs: welcome](https://img.shields.io/badge/PRs-welcome-7096d1.svg)](#贡献)
[![GitHub stars](https://img.shields.io/github/stars/Rice00/dsh-tree-view?style=flat&label=stars&color=7096d1)](https://github.com/Rice00/dsh-tree-view/stargazers)

[特色](#特色) · [安装](#安装) · [上手](#上手) · [设置](#设置) · [原理](#它是怎么做到的) · [**English**](./README.en.md)

</div>

---

## 特色

| | |
|---|---|
| 🌳 **一棵树装下整个家族** | **Tree** 标签页把版本画成轮次级分支图：共用的开头合成主干，分叉处张开成枝。 |
| 🎯 **在读的线整体高亮** | 我从哪来、现在在哪、还能去哪 —— 一张图读完。 |
| 📌 **侧栏永远只有一个入口** | 哪个版本占着侧栏那个位置，跟着你读哪条线走；位置不会越用越多，反悔随时可以。 |
| ✋ **绝不悄悄收走你的会话** | 编辑、重试、从侧栏打开会话、恢复上次阅读位置都不改归档状态 —— 只有你从树里挑版本时才换位。 |
| 🗂️ **长段自动折叠** | 没有任何选择点的连续轮次折成一叠薄片，颜色跟着状态走；阈值按每一段各算，短段不会被旁边的长段连累。 |
| 👁️ **该看的永远看得见** | 对话起点、分叉点、线的末尾，以及你正在生成的那一轮，从不折进去。 |
| ♻️ **收起与放回，随时可逆** | 只翻转归档状态：不新建、不复制、不删除任何会话。 |
| ⚙️ **开关集中在一处** | 设置 → **TreeView**，五项，面板里逐项说明并实时预览。 |
| 🔒 **纯视图，不动数据** | 画树、换位、折叠全部是客户端行为，会话日志一个字节都不改。 |
| 🧩 **可与上游并存** | 行 id `tree-view`、路由 `/tree-view`；持久事件类型保留上游的 `message-tree/version`，已经分过叉的会话直接读出树。 |

## 安装

```bash
dsh plugin --profile web add github:Rice00/dsh-tree-view
```

装完**重启该 profile**（宿主插件模块在进程内缓存，不重启不会加载新行；只改界面的话刷新页面即可）。

想改完即用，就指向本地仓库 —— `link:` 是活链接，源码改完立刻生效：

```bash
dsh plugin --profile web add link:<仓库绝对路径>
```

<details>
<summary><b>让 AI 助手帮你装（整段复制）</b></summary>

```
请帮我安装 DSH 插件 dsh-tree-view：

1) 装进 web profile：
     dsh plugin --profile web add github:Rice00/dsh-tree-view
   或从本地仓库装（填绝对路径）：
     dsh plugin --profile web add link:<绝对路径>
2) 重启该 profile。宿主插件模块在进程内缓存，不重启不会加载新行；只改界面的话刷新页面即可。
3) 验证：设置里出现 TreeView 分类；会话面板出现 Tree 标签页。
   启动日志里应有一行 tree-view。
```

</details>

## 上手

1. **编辑一条已经发出的消息** —— 对话从那一轮重新分叉，与 ChatGPT、Claude 一致，不是从末尾续写。
2. **看全貌** —— 会话面板的 **Tree** 标签页：可平移、滚轮缩放、点节点跳过去。
3. **收进树 / 放回侧栏** —— 右键任意节点；两个动作都只翻转归档状态。

## 设置

全部在 **设置 → TreeView**：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 消息操作样式 | DeepSeek | ChatGPT / DeepSeek / Claude 三种按钮布局，面板内实时预览 |
| 打开我上次在读的那条版本 | 关 | 从别的会话回到这个家族时，回到上次读的那条 |
| 先停掉还在生成的回复 | 开 | 编辑 / 重试前先停掉同一家族里还在跑的回复，省额度 |
| 不画没有新内容的副本 | 开 | 只复制了本对话、自己没聊出新内容的 Fork 不画出来 |
| 折叠过长的连续轮次 | 8 轮及以上 | 永不 / 5 / 8 / 12 / 20 |

## 它是怎么做到的

DSH 的会话是仅追加的事件日志，本身没有「会话内分支」，所以回溯得自己实现：

1. **新建会话做种子** —— 编辑时，宿主以「目标轮次之前的全部事件」为种子创建一个新会话，写入一条持久的 `message-tree/version` 标记说明改了什么，再把改后的提问送进去。这才是真正的回溯。
2. **读回标记还原树** —— 客户端读到这些标记，就能画出整棵树、版本计数，以及你当前站在哪条线上。
3. **`ignorable` 不能少** —— 插件自定义的事件类型不在宿主的事件词表里，缺了这个信封标志，读取端会拒绝解释整份日志，会话直接打不开。

宿主端的分支引擎来自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack），本 fork 在其上重做为 ChatGPT 式回溯语义。

---

<details>
<summary><b>不会静默坏</b></summary>

归档 / 取消归档走 `ctx.workspaceRegistry`：归档用它支持的 `archiveSession`，取消归档得自己写它的状态（**这个 dsh 版本没有 unarchive API**）。宿主耦合集中在 `lib/archive-adapter.js` 一个文件，启动时探测一次：

- 宿主升级后少了哪一环，插件**不装作没事**：启动日志写一行 `archive support is incomplete … missing: …`，面板顶部说明原因，相关按钮与菜单项置灰，树视图其余功能照常。
- 读不到归档集合时**不猜**：宁可什么都不做，也不谎报「没有会话被隐藏」。

</details>

<details>
<summary><b>开发与测试</b></summary>

```bash
npm run build   # 把客户端半边 plugin.client.js 打成 lib/client.js
npm test        # 校验产物是最新的，然后跑全部测试
```

测试是**行为级**的：客户端半边在 jsdom 里按真实的 slot 注册挂载，用真实 DOM 事件驱动，断言的是卡片属性、POST 载荷与导航调用，而不是内部实现。当前 **13 个文件 / 118 条断言**。

```
lib/index.js            宿主半边：分支引擎、归档适配、HTTP 接口
plugin.client.js        客户端半边（源）
lib/client.js           客户端半边（产物，由 scripts/build-client.mjs 打包）
lib/archive-adapter.js  宿主归档能力探测
test/                   行为级测试
docs/                   架构 / 树数据模型 / 开发
```

</details>

## 卸载

```bash
dsh plugin --profile web remove dsh-tree-view
```

不会删除任何会话。

## 文档

- [架构概览](docs/ARCHITECTURE.md) —— 宿主 / 客户端拆分、Cordis 服务注入、持久事件与 HTTP 接口。
- [树数据模型与算法](docs/TREE_DATA_MODEL.md) —— 轮次级树构建、同级展开、Ghost 桥接、高亮路径、长段折叠、主对话换位。
- [开发与测试](docs/DEVELOPMENT.md) —— 构建流程、测试与本地安装。

## 兼容性

| | |
|---|---|
| **DSH** | 已验证 `0.1.5-rc.2`；`engines.dsh` 声明 `>=0.1.5-rc.2 <0.1.6-0`。更新插件后请重启 DSH。 |
| **Profile** | 带 web UI 的 profile（`web`；`desktop` 加上同一行也可以） |
| **界面语言** | 跟随 DSH 的显示语言 |
| **依赖** | 自身不带运行时依赖 |

## 贡献

Issues 与 PR 都欢迎。改完先跑 `npm test`。

## 许可

[MIT](./LICENSE) © Rice00（dsh-tree-view）

本仓库是 [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)（MIT © SpookySandwich）的 fork，其宿主端分支逻辑源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack）。两段原始版权声明按 MIT 要求保留在 `LICENSE`。

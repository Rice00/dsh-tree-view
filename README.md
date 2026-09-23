<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center">把一个对话的所有分支，收进<b>一棵树</b>；侧栏只留<b>一个入口</b>。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center"><a href="README.en.md">English</a> | 简体中文</p>

编辑一条已经发出的消息，对话会从那一刻**真正回溯并分叉** —— 和 ChatGPT、Claude 的做法一致。旧版本不会被覆盖：气泡下方出现 `‹ 2/4 ›` 计数，**Tree** 标签页把整棵版本树画出来，可平移、缩放、跳转。所有分支都是真实会话，版本关系写进持久事件，重启后依旧完整。

本仓库是 [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)（MIT © SpookySandwich）的 **fork**：上游的分支引擎、版本树 UI 与测试全部原样保留，本 fork 把它们从「散落的会话」升级为「**一棵树 + 一个入口**」。

![演示](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/demo-zh.gif)

## 目录

- [本 fork 的改动](#本-fork-的改动)
- [核心规则](#核心规则)
- [版本树](#版本树)
- [界面风格](#界面风格)
- [设置](#设置)
- [安装](#安装)
- [工作原理](#工作原理)
- [与宿主版本的相处方式](#与宿主版本的相处方式)
- [开发与测试](#开发与测试)
- [文档](#文档)
- [兼容性与许可](#兼容性与许可)

## 本 fork 的改动

| 目标 | 状态 |
| --- | --- |
| 树节点**右键重命名**（只改树标签，不碰宿主会话标题） | 已完成 |
| 右键「**放到主对话**」/「**收到 Tree 里**」（promote / demote） | 已完成 |
| 工具栏「**收起其它分支**」：一次把本会话以外的分支收进树 | 已完成 |
| **主对话换位规则**：点已收进 Tree 的节点＝把它放回主对话并把你在看的那条收起；点已在主对话的节点＝只切过去；点当前版本自己的节点＝只回到「对话」分页 | 已完成 |
| **长段折叠**：共用开头、以及任何一路上不分叉的长段，隐藏轮数达到阈值就折成一个节点，点它即展开 | 已完成 |
| 「**剔除空 Fork**」开关（只复制、没新内容的 Fork 是否画出来） | 已完成 |
| **同名轮次合并**：Fork 复制过来的轮次与父版本是同一个节点 | 已完成 |
| 宿主**能力探测 + 归档适配器**（缺接口就优雅降级，绝不静默坏） | 已完成 |
| 「只看最近 N 轮」的截断视图 | 待定 |

## 核心规则

### 一个对话，一个入口

一条对话在侧栏里只该占一个位置，而「哪个版本占着它」跟着你走。于是**切换版本＝一次换位**，判断只看你点的那一步：

| 你点的节点 | 结果 |
| --- | --- |
| **已被收进 Tree**（需要解除归档） | 把它**放回主对话**，同时把**你正在看的那条收起** —— 一次换位，侧栏仍然只有一个条目 |
| **已在主对话** | **只切过去**：不收起、也不放出任何东西（那是你特意放上去的） |
| **属于当前版本自己** | **只回到「对话」分页**并定位到那一轮，不做任何归档 / 放出 |

只有两处会触发换位：**在树里点节点**、**气泡下方的 `‹ ›` 环**。应用自己把你切过去时（编辑产生分叉、从侧栏点会话、上次版本的恢复）**不会改动任何条目的归档状态** —— 否则你一发编辑，原会话就被悄悄收走了。

两条保护：要被收的那条若**已在 Tree 里**，无事可做；若它**正在生成回复**，则跳过收起（但你要打开的那条照常放出）。

### 长段折叠

一个大家族会把大半张画布花在「每个分支都一样」的开头上。判定与画法：

- 一个节点只有**一条去路**（只有一个子节点）＝ 不构成任何选择，连续这样的一串就是**长段**；
- 长段被**两端真正重要的节点**夹住：对话起点、分叉点（≥2 个子节点）、线的末尾、以及**你当前所在会话的最后一轮** —— 这些永远画出来，你正在写的位置不会被藏进折叠里；
- 隐藏轮数达到阈值就折成**一个节点**：点它展开，工具栏的折叠按钮也能展开 / 再折回。折叠节点画成**一叠薄片**（右下偏移），一眼与普通节点区分，颜色跟随卡片状态 —— 在你正读的那条线上是强调色，不在线上是中性灰。

阈值在设置里选：**永不 / 5 / 8 / 12 / 20 轮及以上**（默认 8），并且**按每一段各自的隐藏轮数**算 —— 短的段落不会因为旁边有长段而被折掉。

### 收起与放回

右键任意节点：「**收到 Tree 里**」把它从侧栏收进树（归档），「**放到主对话**」把它放回侧栏（解除归档）。两个动作都只翻转归档状态，不新建、不删除任何会话，随时可逆。

## 版本树

无论对话如何深层分叉、编辑多少次，**Tree** 标签页都会呈现清晰的轮次级分支图，当前所在路径实时高亮，点击任意节点即可跳转：

![版本树](https://raw.githubusercontent.com/Rice00/dsh-tree-view/main/assets/tree-demo.png)

## 界面风格

三种预设的差别只在 **操作按钮放在哪里、有哪些**，颜色始终沿用 DSH 原生配色。预设只改这一件事，不做多余发明 —— 例如只有 Claude 在用户消息上提供重试、没有分享按钮，因为真实界面就是如此。

| 预设 | 气泡下方的按钮 | 显示方式 | 编辑框按钮 |
| --- | --- | --- | --- |
| **ChatGPT** | 编辑、复制 | 悬停时显示 | `取消` / `发送` 在框 **内部** |
| **DeepSeek** | 编辑、复制 | 始终显示 —— 与 DSH 一致 | `取消` / `发送` 在框 **内部** |
| **Claude** | **重试**、编辑、复制 | 悬停时显示 | `取消` / `保存` 在框 **下方** |

## 设置

全部集中在 **设置 → TreeView**：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| **消息操作样式** | DeepSeek | 气泡下按钮的位置与种类，切换即时生效，面板内有实时预览 |
| **打开我上次在读的那条版本** | 关 | 开启后，从别的会话回到这个家族时打开你上次读的那条版本；页面刚加载、你在家族内自己走动、或那条版本已不在侧栏时都不跳 |
| **先停掉还在生成的回复** | 开 | 编辑 / 重试前先取消该会话里所有仍在生成的回复（含其它版本）再分支，避免被取代的回答继续消耗额度 |
| **不画没有新内容的副本** | 开 | 只复制了本对话、自己没聊出新内容的 Fork 不画出来；Tree 工具栏上有同一个开关 |
| **折叠过长的连续轮次** | 8 轮及以上 | 见上文「长段折叠」；可选永不 / 5 / 8 / 12 / 20 |

## 安装

```bash
dsh plugin --profile web add dsh-tree-view
```

从源码安装（开发期推荐，改完即用）：

```bash
dsh plugin --profile web add file:<仓库绝对路径>
```

安装后请重启 DSH：宿主端随服务器加载。界面跟随 DSH 显示语言（中文 / English）。

## 工作原理

DSH 的会话是仅追加的事件日志，本身不支持会话内分支，因此回溯需要另行实现：

- **宿主端**提供 `/tree-view` 接口。编辑消息时，会**以目标轮次之前的全部事件为种子创建一个新会话**，写入持久的 `message-tree/version` 标记说明改动内容，并把编辑后的提问送入。
- 之后读取这些标记，还原出整棵版本树、`‹ n/m ›` 计数，以及当前处于哪个分支。
- 标记事件带有信封上的 `ignorable` 标志。插件自定义的事件类型不在宿主的事件词表内，缺少该标志时读取端会拒绝解释整份日志，会话将直接打不开。
- **客户端**只遮蔽普通的 `user` 消息节点（优先级 `-1`）；思考、工具调用与引导消息仍由宿主渲染。树、换位与折叠都是客户端视图行为，不改变数据。

宿主端的分支逻辑源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack），在其基础上重做为 ChatGPT 式回溯语义、同级分支展开，以及上述界面预设。

**身份说明**：本 fork 的 cordis 行 id 是 `tree-view`、HTTP 路由是 `/tree-view`，与上游的 `message-tree` 完全分开，所以两个插件可以并存安装；但**持久事件类型刻意保留上游的 `message-tree/version`** —— 这样上游已经分过叉的会话，在本 fork 里照样能读出树，迁移不需要改数据。

## 与宿主版本的相处方式

归档与取消归档走 `ctx.workspaceRegistry`：归档用它的 `archiveSession`，取消归档则要自己写它的状态（**这个 DSH 版本没有 unarchive API**）。这块宿主耦合**全部集中在 `lib/archive-adapter.js`**，并在启动时做一次能力探测：

- 宿主升级后如果少了哪一环，插件**不会静默坏**：启动日志写一行 `archive support is incomplete … missing: …`，面板顶部直接说明「收起 / 放到主对话」已停用，相关按钮与菜单项**置灰并给出原因**，树视图其余功能照常。
- 只读能力（`archivedSessionIds`）缺失时，插件**不会猜**：宁可不去归档，也不谎报「没有会话被隐藏」。
- `package.json` 以 `engines.dsh` 声明已验证范围（`>=0.1.5-rc.2 <0.1.6-0`），但真正的护栏是能力探测 —— 版本号只能告诉你宿主变了，探测能告诉你**少了什么**。

## 开发与测试

```bash
npm run build     # 把 plugin.client.js 打成 lib/client.js（客户端半边，prepack 时也会跑）
npm test          # 先校验产物是否最新，再跑全部测试
```

测试是**行为级**的：客户端半边在 jsdom 里挂载真实的 slot 组件，用真实 DOM 事件驱动，断言的是卡片属性、POST 载荷与导航调用，而不是内部实现细节。当前 **13 个测试文件 / 118 条断言**，覆盖：

- `tree.test.mjs`、`tree-state.test.mjs`、`tree-payload.test.mjs` —— 树构建、兄弟展开、Ghost 桥接、高亮路径、宿主载荷；
- `client-tree-filter.test.mjs` —— 折叠、换位规则、工具栏、确认框与画布拖拽；
- `client-remember-path.test.mjs` —— 上次版本的记忆与恢复规则；
- `client-settings.test.mjs` —— 设置面板的名字、每一行与说明；
- `client-branch-menu.test.mjs`、`client-images.test.mjs`、`client-registration.test.mjs`、`archive-adapter.test.mjs`、`host-compatibility.test.mjs`、`session-record.test.mjs`、`seed-runtime.test.mjs` —— 分支右键菜单、图片渲染、注册与降级、归档适配器、宿主兼容、会话记录与种子运行时。

## 文档

- [架构概览 (Architecture)](docs/ARCHITECTURE.md)：宿主 / 客户端架构、Cordis 服务注入、持久事件模型与 HTTP 接口。
- [树数据模型与算法 (Tree Data Model)](docs/TREE_DATA_MODEL.md)：轮次级消息树构建、同级展开、Ghost 桥接、高亮路径、长段折叠与主对话换位规则。
- [开发与测试指南 (Development)](docs/DEVELOPMENT.md)：构建流程、单元测试与本地安装说明。

## 兼容性与许可

本 fork 的 `0.1.0` 基线 = 上游 `dsh-plugin-message-edit@1.1.0` 的全部能力（分支引擎、版本树、界面预设），仅重设了身份：包名 `dsh-tree-view`、cordis 行 id `tree-view`、路由 `/tree-view`、i18n 命名空间与本地存储键也一并改名，避免与上游并存时状态串味。

声明兼容范围为 `>=0.1.5-rc.2 <0.1.6-0`（`package.json` 的 `engines.dsh`）；已验证官方 `0.1.5-rc.2`。DSH 仍在快速迭代，未验证的版本不在此保证范围内；更新插件后请重启 DSH。

MIT © Rice00（dsh-tree-view）。本仓库是 [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)（MIT © SpookySandwich）的 fork；其宿主端分支逻辑源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack）。两段原始版权声明均按 MIT 要求保留在 `LICENSE` 中。

<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center"><b>以树形视图使用会话</b></p>

<p align="center">一条消息改过之后，对话从那一刻重新分叉。所有分叉留在同一棵树里，侧栏只占一个位置。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center"><a href="README.en.md">English</a> | 简体中文</p>

## 会话本来就该是一棵树

DSH 的会话是一份仅追加的事件日志。在它之上编辑一条历史消息，唯一诚实的做法就是**从那一轮之前重新开始**，于是同一个话题长出多个版本 —— 和 ChatGPT、Claude 一样。

分叉本身没有错，问题是它们没有地方住。默认的世界里，每个版本都是侧栏里一个平级的会话：标题后面挂着 `(1)`、`(2)`、`(3)`，谁是谁的前身、哪一步改出来的、现在读到哪，全靠脑子记。分叉越多，侧栏越长。

dsh-tree-view 换一种记法：

> **一个对话 = 一棵树 = 侧栏一个入口。**

版本之间的关系画成树，树的形状就是这段对话的来路；侧栏里只留一个入口，由你正在读的那个版本占着。

## 特色

### 树的形状就是对话的来路

**Tree** 标签页把整个家族画成轮次级的分支图：共用的开头合并成一条主干，分叉处张开成枝。你正在读的那条线整体高亮，于是「我从哪来、现在在哪、还能去哪」在一张图里读完。

### 侧栏永远只有一个入口

这不是「多了一个切版本的按钮」，而是**哪个版本占着侧栏那个位置，跟着你读哪条线走**：把一个旧版本放回主对话，你原本在读的那条就收进树里 —— 位置不增加，反悔也随时可以。

而且**只有你从树里挑版本时才换位**。编辑、重试、从侧栏打开会话、恢复上次的阅读位置，都会碰巧把你带到另一个版本，但它们一个归档状态都不改 —— 否则你随手改一次措辞，原来的会话就被悄悄收走了。

### 大树也看得清

家族长大后，最占地方的往往是那些没有任何选择点的长段：所有分支共用的开头，或者某条线一路直下的一长串轮次。它们达到设定长度就折成一个节点，画成一叠错开的薄片，颜色跟着状态走 —— 在你正读的线上是强调色，不在线上是中性灰。

阈值**按每一段各算**，短段不会因为旁边有长段而被折掉；对话起点、分叉点、线的末尾，以及**你正在生成的那一轮**，永远不折进去。折与不折随时能改。

### 收起和放回，随时可逆

任何一个版本都可以「收到 Tree 里」或「放到主对话」。这两件事只翻转它的归档状态：不新建、不复制、不删除任何会话。

## 安装

```bash
dsh plugin --profile web add dsh-tree-view
```

装完**重启 DSH**（宿主半边随服务器加载）。界面跟随 DSH 的显示语言。

开发期想改完即用，直接装本地目录：

```bash
dsh plugin --profile web add file:<仓库路径>
```

## 设置

全部在 **设置 → TreeView**，面板里带逐项说明：

| 设置 | 默认 | 作用 |
| --- | --- | --- |
| 消息操作样式 | DeepSeek | ChatGPT / DeepSeek / Claude 三种按钮布局，面板内实时预览 |
| 打开我上次在读的那条版本 | 关 | 从别的会话回到这个家族时，回到上次读的那条 |
| 先停掉还在生成的回复 | 开 | 编辑 / 重试前先停掉同一家族里还在跑的回复，省额度 |
| 不画没有新内容的副本 | 开 | 只复制了本对话、自己没聊出新内容的 Fork 不画出来 |
| 折叠过长的连续轮次 | 8 轮及以上 | 永不 / 5 / 8 / 12 / 20 |

## 它是怎么做到的

DSH 的日志没有「会话内分支」，所以回溯得自己实现。三步：

1. **新建会话做种子** —— 编辑时，宿主以「目标轮次之前的全部事件」为种子创建一个新会话，写入一条持久的 `message-tree/version` 标记说明改了什么，再把改后的提问送进去。这才是真正的回溯，而不是从末尾续写。
2. **读回标记还原树** —— 客户端读到这些标记，就能画出整棵树、版本计数，以及你当前站在哪条线上。
3. **`ignorable` 不能少** —— 插件自定义的事件类型不在宿主的事件词表里，缺了这个信封标志，读取端会拒绝解释整份日志，会话直接打不开。

树的画法、换位、折叠**全部是客户端视图行为**，不改动任何数据。

宿主端的分支引擎来自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack），本 fork 在其上重做为 ChatGPT 式回溯语义与上述规则。

**身份**：cordis 行 id 是 `tree-view`、路由 `/tree-view`，与上游的 `message-tree` 分开，两个插件可以并存；但**持久事件类型刻意保留上游的 `message-tree/version`** —— 上游已经分过叉的会话，在这里照样能读出树，迁移不用改数据。

## 不会静默坏

归档 / 取消归档走 `ctx.workspaceRegistry`：归档用它支持的 `archiveSession`，取消归档得自己写它的状态（**这个 dsh 版本没有 unarchive API**）。这块宿主耦合集中在 `lib/archive-adapter.js` 一个文件里，启动时探测一次：

- 宿主升级后少了哪一环，插件**不会装作没事**：启动日志写一行 `archive support is incomplete … missing: …`，面板顶部直接说明，「收起 / 放到主对话」相关按钮与菜单项置灰并给出原因，树视图其余功能照常。
- 读不到归档集合时，插件**不猜**：宁可什么都不做，也不谎报「没有会话被隐藏」。

## 开发与测试

```bash
npm run build   # 把客户端半边 plugin.client.js 打成 lib/client.js
npm test        # 校验产物是最新的，然后跑全部测试
```

测试是**行为级**的：客户端半边在 jsdom 里按真实的 slot 注册挂载，用真实 DOM 事件驱动，断言的是卡片属性、POST 载荷与导航调用，而不是内部实现。当前 **13 个文件 / 118 条断言**，覆盖树构建、折叠与换位规则、工具栏与确认框、设置面板、记忆与恢复、图片渲染、注册与降级、归档适配器、宿主兼容。

## 文档

- [架构概览](docs/ARCHITECTURE.md) —— 宿主 / 客户端拆分、Cordis 服务注入、持久事件与 HTTP 接口。
- [树数据模型与算法](docs/TREE_DATA_MODEL.md) —— 轮次级树构建、同级展开、Ghost 桥接、高亮路径、长段折叠、主对话换位。
- [开发与测试](docs/DEVELOPMENT.md) —— 构建流程、测试与本地安装。

## 兼容性与许可

- 已验证 dsh **`0.1.5-rc.2`**；`engines.dsh` 声明 `>=0.1.5-rc.2 <0.1.6-0`。DSH 迭代很快，未验证的版本不在保证范围内；更新插件后请重启 DSH。
- MIT © Rice00（dsh-tree-view）。本仓库是 [dsh-plugin-message-edit](https://github.com/SpookySandwich/dsh-plugin-message-edit)（MIT © SpookySandwich）的 fork，其宿主端分支逻辑源自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack）。两段原始版权声明按 MIT 要求保留在 `LICENSE`。

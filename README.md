<p align="center">
  <img src="assets/logo.png" alt="dsh-tree-view" width="180">
</p>

<h1 align="center">dsh-tree-view</h1>

<p align="center">一个对话 = 一棵树 = 侧栏一个入口</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-tree-view"><img src="https://img.shields.io/npm/v/dsh-tree-view?color=cb3837&logo=npm" alt="npm"></a>
  <a href="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml"><img src="https://github.com/Rice00/dsh-tree-view/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="license"></a>
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4b8dff" alt="dsh">
</p>

<p align="center"><a href="README.en.md">English</a> | 简体中文</p>

编辑一条已经发出的消息，对话会**从那一刻重新分叉** —— 和 ChatGPT、Claude 一样，不是从末尾续写。旧版本不会被覆盖，而是长成一棵树：气泡下方出现 `‹ 2/4 ›` 可以来回切，**Tree** 标签页把整棵树画出来。

这也是它和普通「编辑消息」插件的区别：它不只让你改一句话，而是让**一个对话的所有分支有地方住**。

![演示](assets/demo-zh.gif)

## 30 秒看懂

- **改一句话就能回溯** —— 编辑历史消息，从那一轮之前重新生成，上下文完整。
- **分支是一棵树** —— Tree 标签页里平移、滚轮缩放、点节点跳过去，你正在读的那条线实时高亮。
- **侧栏只留一个入口** —— 切换版本时自动「换位」，而不是越用越多、越找越乱。
- **大树也看得清** —— 又长又直、没有任何分叉的段落自动折成一个节点，点开即看。

## 关键功能

### 1. 主对话换位：侧栏永远一个入口

一个对话在侧栏里只该占一个位置，而**「哪个版本占着它」跟着你走**。所以你点一下就是一次换位：

| 你点的节点 | 会发生什么 |
| --- | --- |
| **已被收进 Tree**（在树里、不在侧栏） | 它**回到主对话**，你原本在看的那条**收进 Tree** |
| **已在主对话**（侧栏里就有） | **只切过去** —— 什么都不收，也不放 |
| **属于你正在看的这个版本** | 只回到**「对话」分页**，并定位到那一轮 |

只有两件事会触发换位：**在树里点节点**、**气泡下方的 `‹ ›` 环**。其余情况 —— 编辑产生分叉、从侧栏点会话、恢复上次版本的跳转 —— **绝不改动任何归档状态**。这一点是刻意的：否则你随手编辑一次，原会话就被悄悄收走了。

两条保护：正在生成回复的那条不会被收起；要收起的那条本来就已在树里，也就无事可做。

### 2. 长段折叠：家族再大也不是一根长竹竿

一个家族里，「所有分支都一样的开头」和「某条线一路直下、中途没有任何分叉的连续轮次」其实没有选择点，却会占掉大半张画布。于是：

- **达到阈值就折成一个节点** —— 设置里可选 **永不 / 5 / 8 / 12 / 20 轮及以上**（默认 8）。阈值**按每一段各自算**：短段不会因为旁边有长段而被折掉。
- **点它展开**，工具栏的折叠按钮也能展开、再折回。
- **该看的永远看得见** —— 对话起点、分叉点、线的末尾、以及**你正在写的那一轮**，从不折进节点里。
- **一眼可分** —— 折叠节点画成一叠薄片（右下错开），颜色跟着状态走：在你正在读的线上是强调色，不在线是中性灰。

### 3. 版本树

**Tree** 标签页把整个家族画成轮次级分支图：可平移、滚轮缩放、点任意节点直接跳过去。你正在读的那条线（包括上面的共用历史）一起高亮，所以「我从哪来、现在在哪、还能去哪」一眼就看得到。

![版本树](assets/tree-demo.png)

### 4. 收起 / 放回，随时可逆

右键任意节点：**收到 Tree 里** 把它从侧栏收进树，**放到主对话** 把它放回侧栏。两个动作都只翻转归档状态 —— 不新建、不删除任何会话，随时可以反悔。

### 5. 一个地方管所有开关

全部在 **设置 → TreeView**：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| **消息操作样式** | DeepSeek | ChatGPT / DeepSeek / Claude 三种按钮布局，面板内实时预览 |
| **打开我上次在读的那条版本** | 关 | 从别的会话回到这个家族时，回到你上次读的那条版本 |
| **先停掉还在生成的回复** | 开 | 编辑 / 重试前先停掉同一家族里还在跑的回复，省额度，也让你能在回复途中编辑 |
| **不画没有新内容的副本** | 开 | 只复制了本对话、自己没聊出新内容的 Fork 不画出来 |
| **折叠过长的连续轮次** | 8 轮及以上 | 见「长段折叠」，可选永不 / 5 / 8 / 12 / 20 |

## 安装

```bash
dsh plugin --profile web add dsh-tree-view
```

装完**重启 DSH**（宿主半边随服务器加载）。界面跟随 DSH 的显示语言。

开发期想改完即用，直接装本地目录：

```bash
dsh plugin --profile web add file:<仓库路径>
```

## 它是怎么做到的

DSH 的会话是仅追加的事件日志，本身没有「会话内分支」，所以回溯要自己实现。三步：

1. **新建会话做种子** —— 编辑消息时，宿主以「目标轮次之前的全部事件」为种子创建一个新会话，写入一条持久的 `message-tree/version` 标记说明改了什么，再把编辑后的提问送进去。这就是真正的回溯。
2. **读回标记还原树** —— 客户端读到这些标记，就能画出整棵树、`‹ n/m ›` 计数，以及你当前站在哪条线上。
3. **`ignorable` 标记不能少** —— 插件自定义的事件类型不在宿主的事件词表里，缺了这个信封标志，读取端会拒绝解释整份日志，会话直接打不开。

树的画法、换位、折叠**全部是客户端视图行为**，不改动任何数据。

宿主端的分支引擎来自 [dsh-message-edit](https://github.com/Moeblack/dsh-message-edit)（MIT © Moeblack），本 fork 在其上重做为 ChatGPT 式回溯语义与上述规则。

**身份**：本 fork 的 cordis 行 id 是 `tree-view`、路由是 `/tree-view`，与上游的 `message-tree` 分开，两个插件可以并存；但**持久事件类型刻意保留上游的 `message-tree/version`** —— 上游已经分过叉的会话，在这里照样能读出树，迁移不用改数据。

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

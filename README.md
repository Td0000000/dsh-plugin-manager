# dsh-plugin-manager

DeepSeek Harness (DSH) 设置页插件管理独立插件（含自由浮动的像素吉祥物快捷控制面板）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Compatibility](https://img.shields.io/badge/DSH-0.2.x%20%3E%3D0.2.0--rc.1%20(%3C0.3.0)-brightgreen.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![Cordis Compatibility](https://img.shields.io/badge/Cordis-%5E4.0.2-orange.svg)](https://github.com/deepseek-ai/cordis)

---

## 适配版本说明

- **DeepSeek Harness (DSH)**：适配 `0.2.x` 系列，**已在 `0.2.0-rc.2`（内置 `@deepseek-ai/cordis@4.0.4`）实机验证安装**：宿主条目正常挂载、客户端 bundle 正常注入 `__DSH_BOOT__`、设置页与浮动面板 API 全部可用。
- **微内核架构**：基于 `@deepseek-ai/cordis` 插件生命周期、Cordis Loader 与配置 Patch 机制。
- **环境要求**：Node.js `>= 20.0.0`，pnpm `>= 9.0.0`，React `>= 18.0.0`。

### 从 1.0.1 到 1.0.2 的适配改动

| 问题 | 说明 | 处理 |
| --- | --- | --- |
| 档案（Profile）定位错误 | `0.1.x` 通过 `--profile <name>` 启动；`0.2.x`（含 Electron Desktop Host）改为**位置参数**传入档案目录（`<dshRoot> <profileDir> <runtimeDir> <pnpm> <bin>`），旧代码因此回退到并不存在的 `profiles/web`，导致插件列表为空、启停写错目录 | `resolveProfileDir()` 依次识别：显式路径 → `--profile` → argv 中 `…/profiles/<name>` 位置参数 → `DSH_PROFILE` → 唯一已安装档案 |
| 引擎声明过期 | `dsh.plugin.json` 声明 `engines.dsh: >=0.1.2-rc.1 <0.2.0`，把当前版本挡在范围外 | 更新为 `>=0.2.0-rc.1 <0.3.0` |
| 语言探测失效 | `0.2.x` 的语言服务暴露 `getLocale()`，旧代码只探测 `get()` / `current` | 优先读 `getLocale()`，并兼容 `{ active }` 结构 |

> ⚠️ **重要说明（当前阶段安装注意）**：
> 目前 DeepSeek Harness 官方框架尚处于快速迭代与演进中，**尚未面向公共 npm 仓库打包编译发布全局预发版**。
> 因此，用户无法通过常规远程网络命令直接开箱即用。
> **当前使用方式**：必须将本插件仓库代码**克隆/拉取到本地**，然后**让本地 AI（Pi / Claude Code / Cursor / Windsurf / DSH 内置 Coding Agent）帮您完成装载**，或通过本地 Link 方式引入。

---

## 让 AI 帮我装（推荐方式）

如果您正在使用 AI 编程助手（例如 Pi、Claude Code、Cursor、Windsurf 或 DSH 内部的 Coding Agent），请**将本插件拉到本地**后，直接复制下方提示词发给 AI：

```markdown
请帮我将本地的 DSH 插件管理插件接入到当前运行的 DeepSeek Harness 中：

1. 本地插件路径：/你的本地路径/dsh-plugin-manager（请替换为实际绝对路径）
2. 请进入该插件目录执行 `pnpm install` 与 `pnpm run build`，确保已完成编译构建出 lib 产物；
3. 请定位当前使用的 DSH Profile 目录（DSH 0.2.x 位于 `~/.dsh/profiles/<档案名>/`，例如 `desktop`、`web`）：
   - 把构建产物复制到 `~/.dsh/plugins/dsh-plugin-manager`；
   - 在其 `package.json` 的 `dependencies` 中添加："dsh-plugin-manager": "link:C:/Users/你的用户名/.dsh/plugins/dsh-plugin-manager"；
   - 在其 `package.json` 的 `dsh.profile.bundles` 数组**末尾**追加："dsh-plugin-manager"；
     （该 bundle 自带的 `cordis.patch.yml` 会自动插入并启用 Loader 条目，**无需**手写 patch）
4. 在 Profile 目录下执行 `pnpm install`，并触发 DSH 热重载或重启 DSH；
5. 刷新浏览器页面，检查「设置 → 插件 → 插件管理」是否已出现面板，且右下角是否已显示像素吉祥物浮动小部件。
```

> 提示：如果 DSH 已启用 HMR，第 3、4 步完成后宿主会**热重组**并立即挂载，无需重启进程。

---

## 手动安装与接入步骤

### 第一步：克隆到本地并编译构建

```bash
# 1. 克隆本仓库到本地任意目录
git clone https://github.com/Td0000000/dsh-plugin-manager.git
cd dsh-plugin-manager

# 2. 安装依赖并执行构建（必须构建出 lib/ 产物）
pnpm install
pnpm run build
```

### 第二步：把构建产物接入 DSH Profile（0.2.x）

进入您的 DSH 配置目录（DSH 0.2.x 为 `~/.dsh/profiles/<档案名>/`，例如 `desktop`、`web`）：

1. **复制构建产物到插件目录**：
   ```bash
   mkdir -p ~/.dsh/plugins/dsh-plugin-manager
   cp -r lib cordis.patch.yml dsh.plugin.json package.json README.md LICENSE ~/.dsh/plugins/dsh-plugin-manager/
   ```

2. **编辑 Profile 的 `package.json`**，在 `dependencies` 中引入本地路径，并把包名加入 `dsh.profile.bundles`：
   ```json
   {
     "dependencies": {
       "dsh-plugin-manager": "link:C:/Users/你的用户名/.dsh/plugins/dsh-plugin-manager"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-plugin-manager"
         ]
       }
     }
   }
   ```
   > `dsh.profile.bundles` 决定加载顺序，请**追加到末尾**，以免改变已有 bundle 的配置优先级。

3. **无需手写 `cordis.patch.yml`**：本插件的 `dsh.bundle.patch`（`cordis.patch.yml`）会在组合阶段自动 `insert` 出 `td-plugin-manager` 条目并启用它。仅当需要覆盖配置时，才在 Profile 的 `cordis.patch.yml` 中按 `id: td-plugin-manager` 追加 patch。

4. **安装依赖并刷新页面**：
   ```bash
   pnpm install
   ```

> 也可以直接使用 DSH 内置的插件管理器安装：`plugin_manager install_bundle`，target 传本地插件目录绝对路径即可，宿主会自动完成依赖写入、bundle 选择与热重组。

完成后刷新浏览器页面，即可在「设置 → 插件 → 插件管理」中看到管理面板，并在页面右下角看到浮动吉祥物。

---

## 页面使用文档与界面交互指南

本插件提供 **两种操作形态**：
1. **设置页插件管理中心**：功能最完备的沉浸式管理界面（支持分组维护、批量启停、一键卸载、浮窗设置等）。
2. **像素吉祥物浮动控制台**：常驻页面右下角的可拖拽悬浮小部件，无需跳转页面即可随时调出快捷启停面板。

---

### 一、设置页插件管理中心

#### 1. 页面入口
- 打开 DSH Web 页面，点击侧边栏或右上角 **「设置」** -> 在左侧分类栏选择 **「插件管理」**。

#### 2. 核心区域介绍

```
+-----------------------------------------------------------------------------------------+
|  顶部控制栏                                                                             |
|  [当前 Profile: web]  [统计: 已安装 X 个]   [🔍 搜索插件...]   [+ 新建分组]   [⟳ 刷新页面] |
+-----------------------------------------------------------------------------------------+
|  ▼ 📂 自定义分组 A (2/3 启用)                           [全部启用] [全部禁用] [⚙ 分组操作] |
|  +-----------------------------------------------------------------------------------+  |
|  | 插件名称      版本/描述           所属分组: [选择▾]         [启/停开关]  [🗑 卸载]  |  |
|  +-----------------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------------+
|  ▼ 📂 未分组插件 (Ungrouped)                            [全部启用] [全部禁用]            |
|  +-----------------------------------------------------------------------------------+  |
|  | 插件名称      版本/描述           所属分组: [选择▾]         [启/停开关]  [🗑 卸载]  |  |
|  +-----------------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------------+
```

#### 3. 功能操作指南

- **自定义持久化分组**：
  - 点击顶部 **「+ 新建分组」**，输入名称即可创建新分组。
  - 分组支持**重命名**与**删除**（删除分组仅解散归类，内部插件自动归入「未分组」，不会影响插件安装）。
  - 分组配置自动持久化保存在当前 Profile 目录下的 `td-plugin-groups.json` 文件中，换机器或重启服务永不丢失。
- **插件在分组间自由归类**：
  - 每个插件卡片中央提供所属分组下拉选择框，点击即可将插件自由划分到任一分组或移回未分组。
- **分组一键批量启停**：
  - 每个分组标题栏右侧配备 **「全部启用」** 与 **「全部禁用」** 按钮，支持项目组整体一键切换运行环境。
- **单插件高灵敏滑动开关**：
  - 切换单个插件开关时，后端精确读写 `cordis.patch.yml` 并等待宿主 loader 达到稳定状态（`settled`）。
- **一键安全彻底卸载**：
  - 用户自主安装的扩展插件卡片右侧显示红色垃圾桶图标。
  - 点击确认后，自动清理 Profile 下的 `package.json` 依赖声明、`cordis.patch.yml` 配置并移除模块目录，杜绝冗余残留。
  - 系统核心组件与底层服务自动锁定保护，避免误删导致框架异常。
- **💡 为什么需要「刷新页面」？**
  - **机制说明**：DSH 客户端的前端插件依赖图（Client Plugin Registry）是由宿主服务在浏览器页面加载的时刻完成注入的。因此在修改了插件的开启/关闭/卸载状态后，点击 **「⟳ 刷新页面」** 是让浏览器获取最新插件图的最安全、最可靠的方式。

---

### 二、像素吉祥物浮动控制台（Floating Widget）

#### 1. 浮窗外观与常驻交互
- 默认悬浮在屏幕右下角，展示憨态可掬的像素小鲸鱼形象。
- **自由拖拽**：按住吉祥物图标可随意拖动到视口内任意边缘或舒适位置，松开鼠标后自动保存位置。
- **折叠与展开**：点击吉祥物即可展开/收起浮动快捷控制卡片。

#### 2. 快捷面板功能
- **实时状态一览**：浮窗面板内分组展示已安装插件及其当前启停状态。
- **快速切换**：在浮窗中直接点击开关即可开启或停用插件。
- **一键整页刷新**：浮窗右上角自带刷新按钮，切换插件后随手一按立即生效。

#### 3. 深度个性化定制（设置弹窗）
在设置页「插件管理」顶部点击 **「浮窗设置」**：
- **自定义吉祥物形象**：支持上传本地图片（PNG/JPG/SVG/GIF，小于 2MB），替换默认像素鲸鱼为您的专属个人头像或项目 Logo，设置保存在浏览器本地持久化缓存中。
- **浮窗展示分组过滤**：如果插件较多，可在配置弹窗中仅勾选您最关心的特定分组在浮窗中展示，使悬浮面板更加小巧清爽。

---

## 本地开发与构建

```bash
# 1. 安装项目依赖
pnpm install

# 2. 编译 TypeScript 与打包 Web 客户端
pnpm run build
```

产物解析：
- `lib/index.js`：Cordis 后端核心服务，提供插件扫描、YAML Patch 修改、分组数据管理与文件清理等 RESTful/RPC 接口。
- `lib/client.js`：包含前端 React 设置页主面板与全局注入的像素吉祥物浮动组件（`FloatingPluginManager`）。

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE)。

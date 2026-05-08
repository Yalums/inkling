# ADR 0001 — 以 QuickToolbar 为插件模板

**日期**：2026-05-08
**状态**：已采纳

## 背景

Inkling 是一个全新的 Supernote 插件。当前仓库 `/home/user/inkling` 已有一个完整的 Supernote 插件 **QuickToolbar**（floating toolbar / 截图 / 剪贴板 / LocalSend），它已经把以下问题解决到可用状态：

- `PluginConfig.json` 字段约定（pluginID / pluginKey / iconPath / jsMainPath / versionCode 等）
- `PluginManager.registerButton` / `registerConfigButton` 与 `showType` 0/1 的差异
- `pendingButton.js` 模块级状态在 button click 与 RN mount 之间路由初始 screen
- 模块级事件监听器（`FloatingToolbarBridge.onToolTap`）在进程常驻、不依赖 App.tsx 生命周期
- Kotlin `ReactContextBaseJavaModule` + `ReactPackage` + `MainApplication` 注册的整套样板
- e-ink 单色调色板与无阴影/无渐变约束
- `i18n.ts` 简易国际化骨架

## 决策

直接以 QuickToolbar 仓库为 Inkling 的起点，**复用其全部插件模板部分**（构建结构、注册流程、样式骨架、i18n、native module 模式），**删除其业务部分**（toolbar / bubble / screenshot / localsend / clipboard），并在腾出的空间里搭建 Inkling 自己的业务（文档解析 / 排版 / 渲染 / PDF 封装）。

## 理由

- **避免重新踩坑**：Supernote SDK 与 RN 集成的细节（如 `showType` 行为、PluginManager init 时序、Kotlin module 注册方式）在 QuickToolbar 里已经验证过。
- **e-ink 样式与 i18n 是横切关注点**：和插件业务无关，可以无成本继承。
- **保持单仓库**：不引入 git submodule 或新仓库，所有改动直接在 `claude/design-plugin-template-244iJ` 上推进。

## 后果

- **风险**：如果 QuickToolbar 在某些细节上做了不通用的假设（例如某个 LocalSend 的依赖顺序泄漏到 MainApplication），删除时要小心。M0 阶段会有专门的瘦身工作。
- **包名变更**：`com.supernote_quicktoolbar` → `com.supernote_inkling`，需要同步改 `AndroidManifest.xml`、所有 Kotlin 文件、JNI 函数名（`Java_com_supernote_1inkling_*`）。
- **未来一致性**：后续如果还要派生其他 Supernote 插件，建议把 QuickToolbar 的"模板部分"提取成一个独立 starter 仓库；本次先不做这个抽象。

## 参考

- 模板源仓库：`claude/design-plugin-template-244iJ` 分支（即本仓库当前内容）
- QuickToolbar 主要文件：`PluginConfig.json` / `index.js` / `App.tsx` / `components/*` / `main/java/com/supernote_quicktoolbar/*`

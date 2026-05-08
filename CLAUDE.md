# Inkling — Supernote 文档转换插件

> 这是项目记忆文件。新会话冷启时优先读取这里恢复上下文。
> 完整设计依据见 `docs/architecture.md`、`docs/milestones.md`、`docs/decisions/`。

## 项目愿景

Inkling 是一个 Supernote 设备上的文档转换插件，把任意文本文档（TXT / Markdown / EPUB / DOCX / 带文字层的 PDF）转换成**横屏竖排、原生 1920×2560 位图、带不可见 OCR 文字层和书签目录的 PDF**。

**为什么需要它**：Supernote 自带阅读器对所有文档统一按 1920×1840 渲染（瑞芯微 RK3566 SoC 的图像通路上限做了二压），导致 7.8" 和 10.65" 设备都拿不到原生 300 PPI 的字体锐利度。流式排版（EPUB 等）在墨水屏上字体边缘明显发虚。Inkling 绕开这条路径：**预先把内容渲染成原生分辨率的位图 PDF**，让设备直接显示位图，跳过系统的二压。

## 范围决策

| 项 | 决策 |
|---|---|
| 入口按钮 | 仅插件管理页的 **Config Button**（不挂 NOTE / DOC 侧栏） |
| 首期格式 | TXT / Markdown / EPUB / DOCX / 带文字层 PDF（全量，分阶段交付） |
| 输出格式 | 单一格式：图像 PDF + 不可见文字层 + 书签目录 |
| 目标分辨率 | 默认 1920×2560（10.65" / 300 PPI），横屏单页 2560×960（一页一分为二） |
| 默认排版 | 横屏 + 竖排（从右到左，从上到下） |
| C/C++ 核心 | NDK + CMake + JNI；C++ 核心**平台无关**，桌面端编译路径预留 |
| 桌面端 | 首期仅 Android；CMake 留 desktop target 接口 |
| 语言 | 中文（简/繁）+ 英文 |
| UI 层 | **占位中**，等用户给的参考项目到位后再展开 |

## 整体架构

```
┌─────────────────────────────────┐
│   App.tsx (RN UI, screen 路由)   │
│  pick / configure / progress    │
└──────────────┬──────────────────┘
               │ NativeModules.InklingCore
┌──────────────▼──────────────────┐
│  Kotlin Native Module           │
│  main/java/.../InklingCore*     │
└──────────────┬──────────────────┘
               │ JNI（仅一层薄封装）
┌──────────────▼──────────────────┐
│  cpp/  —— 平台无关 C/C++ 核心     │
│  ├── parser/   txt md epub docx pdf │
│  ├── layout/   HarfBuzz vertical-rl │
│  ├── render/   FreeType → bitmap    │
│  ├── encode/   libjpeg-turbo        │
│  └── pdf/      libharu + 文字层 + 书签│
└─────────────────────────────────┘
```

完整层级与目录结构详见 `docs/architecture.md`。

## 模板来源

本仓库的当前代码是一个已成型的 Supernote 插件 **QuickToolbar**（floating toolbar / 截图 / 剪贴板）。Inkling 复用它的：

- RN + Kotlin 原生模块 + 模块级事件监听结构
- `PluginManager` / `PluginNoteAPI` 调用模式
- `pendingButton.js` 路由模式
- e-ink 单色调色板（`#111111` / `#FFFFFF` / `#DDDDDD` / `#888888`，1–1.5px 边框，无阴影无渐变）
- `i18n.ts` 国际化骨架
- `FileLogger.ts`

详见 `docs/decisions/0001-template-from-quicktoolbar.md`。

## 模块边界（重要）

为了让 C++ 核心可以同时给 Android 和桌面端使用，强制约束：

1. **`cpp/inkling/` 不允许出现 `#include <jni.h>` 或 `<android/log.h>`**。日志通过抽象的 `inkling::Logger` 接口注入。
2. **文件 IO 走 `std::filesystem`**（C++17），不依赖 Android `AAsset*`。Android 侧 Kotlin 负责把 SAF URI 复制到沙盒文件后再把路径传进 JNI。
3. **对外接口是纯 C ABI**（`cpp/inkling/include/inkling/api.h`），JNI 和 desktop CLI 共享同一组函数。
4. **进度回调走函数指针** `typedef void (*ProgressCb)(const char* jobId, int stage, int percent, void* userdata);` —— Android 侧塞一个 trampoline 转成 `JNIEnv->CallVoidMethod`；CLI 侧塞一个 stderr 打印的 cb。

## 当前状态

- [x] M-1：项目记忆文档（本文件 + `docs/`）写入并提交
- [ ] M0：模板瘦身（删 toolbar/bubble/screenshot/localsend，改包名为 `supernote_inkling`）
- [ ] M1：C++ 核心骨架 + JNI hello + RN 假进度事件
- [ ] M2：TXT/MD → 横排 PDF
- [ ] M3：横屏竖排
- [ ] M4：文字层 + 书签
- [ ] M5–M7：EPUB / DOCX / PDF 输入
- [ ] M8：4 核并行 + 性能调优
- [ ] M9（预留）：桌面 CLI

完整路线图与验证标准见 `docs/milestones.md`。

## 待解问题

- **字体打包**：Supernote 预装字体未知；建议默认随插件打包思源宋体（SourceHanSerif）并明确 SIL OFL 许可。
- **MuPDF 许可**：AGPL，会传染整个分发包；M7（PDF 输入）之前必须决策是否换 PoDoFo（LGPL）。
- **libharu 子集化**：libharu 嵌字体若不做 subset，PDF 体积会爆；M4 之前确认。
- **第三方库引入方式**：倾向 CMake `FetchContent` + 锁 commit，而非 git submodule 或 vendoring。
- **gradle wrapper**：模板仓库当前没有 `package.json` / `build.gradle` 等可见的构建文件，构建链路由 Supernote 工具链外部管理；M0 落地前需要确认是否能在本仓库内暴露完整 NDK + Gradle 构建。

## 验证（端到端）

```bash
cd /home/user/inkling
./gradlew assembleRelease   # 假定 M0 之后可用
adb install -r app/build/outputs/apk/release/app-release.apk
# 设备：插件管理 → Inkling → 选一个 .md → 转换
# 在 DOC 阅读器里打开输出 PDF：
#   - 字体边缘锐度对比系统阅读器
#   - 选中文字（验证不可见文字层）
#   - 目录跳转（验证 bookmark）
```

## 性能基线（M8 验收，RK3566 + 4GB）

| 文档规模 | 4 核并行 + JPEG q90 |
|---|---|
| 20 页 MD | < 30 秒 |
| 200 页 EPUB | < 4 分钟 |
| 500 页 EPUB | < 11 分钟 |

## 工作分支

- 主干：`main`
- 当前开发分支：`claude/design-plugin-template-244iJ`

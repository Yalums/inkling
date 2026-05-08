# ADR 0002 — C/C++ 核心 + NDK + 桌面端预留

**日期**：2026-05-08
**状态**：已采纳

## 背景

Inkling 的转换流水线（解析 → 排版 → 渲染 → 封装）在功能上需要：

| 阶段 | 候选库 |
|---|---|
| 文本解析 | cmark（MD）、libzip + libxml2（EPUB / DOCX）、MuPDF（PDF 文字层） |
| 文字 shaping | HarfBuzz（业界标准，支持 vertical-rl） |
| 字形渲染 | FreeType |
| 图像编码 | libjpeg-turbo |
| PDF 封装 | libharu（含不可见文字层 + 书签 outline） |

这些库**全部以 C/C++ 提供**，且都有成熟的 Android NDK 编译路径。

同时，用户希望未来能在桌面端跑同样的转换流程（CLI 形态），不依赖 Supernote 设备。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| **A. NDK + CMake + JNI**（采纳） | 真实使用业界标准 C 库；性能最优；天然跨平台（同一套 cpp/ 也能编 desktop CLI） | 引入 NDK 构建复杂度；需要写 JNI trampoline |
| B. 纯 Kotlin/Java JVM 实现 | 无 NDK；首期最简单 | Android Canvas/Paint 无法满足竖排 + 像素级控制；性能比 native 慢 5–10×；不可能复用到桌面 |
| C. 把 cpp 核心放独立子仓库 | 插件主仓库轻 | 引入 submodule / 二进制依赖管理；冷启上手成本高；首期不必要 |

## 决策

采纳 **A**：在本仓库新增 `cpp/` 目录，用 CMake 组织 C/C++ 核心，通过 Android Gradle 的 `externalNativeBuild` 集成进 APK 构建。

**关键设计约束**（M9 桌面端能直接复用，不重构）：

1. `cpp/inkling/` 平台无关，不允许 `#include <jni.h>` 或 `<android/log.h>`
2. 文件 IO 走 `std::filesystem`（C++17），不依赖 Android `AAsset*`
3. 对外接口 `cpp/inkling/include/inkling/api.h` 是纯 C ABI（`inkling_convert(...)`）
4. JNI 层 `cpp/jni/inkling_jni.cpp` 只做字符串搬运和线程附加，无业务逻辑
5. 进度回调走函数指针 `typedef void (*inkling_progress_cb)(...);`，不用全局状态
6. CMake 顶层 `if(ANDROID)` 构建 `libinkling_jni.so`；其他 toolchain 构建 `inkling_cli` 可执行文件

第三方库通过 CMake `FetchContent_Declare` + `FetchContent_MakeAvailable` 拉取并锁定 commit，避免 git submodule 的脆弱性，也避免 vendoring 整树进仓库的体积压力。

## 理由

- **性能必要**：RK3566 的 4× Cortex-A55 单核性能弱，纯 JVM 渲染 1920×2560 位图的开销在 200 页书上很难接受；HarfBuzz + FreeType + libjpeg-turbo 在 native 是经过多年优化的。
- **功能必要**：HarfBuzz 的 vertical-rl 排版、libharu 的 invisible text layer、MuPDF 的文字层提取在 JVM 没有等价实现。
- **跨平台代价低**：只要从立项起遵守上述约束，桌面端 CLI 在 M9 阶段只需要新增一个 toolchain target，不需要重写任何核心代码。
- **包体积可控**：所有第三方库都支持子集编译（HarfBuzz 可关 ICU、FreeType 可关多种格式、libharu 可关 PNG/JPEG 解码而只用编码），可在后期 trim。

## 后果

- **构建链路必须可用**：M0 阶段要确认本仓库能否暴露完整的 NDK + Gradle 构建（当前仓库根没有可见的 `package.json` / `build.gradle`，可能由 Supernote 工具链外部管理）。如果不能，M0 之前需要补齐构建文件。
- **MuPDF 的 AGPL 风险**：M7（PDF 输入）会引入 MuPDF；AGPL 会传染整个分发包。在 M7 之前必须决策是否换 PoDoFo（LGPL）或购买 MuPDF 商业授权。
- **JNI 字符串生命周期**：JNI trampoline 里的 `JavaVM*` / `jobject globalRef` 必须严格管理 attach/detach 与 `DeleteGlobalRef`，否则 Android 会泄漏。M1 阶段写 JNI 桩时建立模板代码并复用。
- **首次构建较慢**：FetchContent 第一次会下载并编译所有第三方库；后续靠 `build/` 缓存。CI 上需要缓存 `build/` 目录。

## 参考

- 完整目录结构与 CMake 草稿：`docs/architecture.md` 第 2 / 5 节
- 桌面端预留约束清单：`CLAUDE.md` 「模块边界」节

# 里程碑路线图

阶段化交付，避免一次性引入 6+ 个 C 库的复杂度。每个阶段都要能在设备上跑出端到端可见效果。

> UI 层（App.tsx 的 screens）当前**留白**，等用户提供的参考项目到位后再展开。其它阶段照常推进。

| 阶段 | 范围 | 验证 |
|---|---|---|
| **M-1** | **项目记忆文档**：`CLAUDE.md` + `docs/architecture.md` + `docs/milestones.md` + `docs/decisions/000{1,2}*.md`。提交并 push 到工作分支。**不动任何代码**。 | `git log` 看到一条新 commit；`CLAUDE.md` 在仓库根，新会话冷启时能从中恢复全部上下文 |
| **M0** | **模板瘦身**：<br>• 删除 components/ 内 toolbar / bubble / screenshot / localsend / clip 相关 TS<br>• 删除 main/java 对应 Kotlin module<br>• `MainApplication.kt` 的 ReactPackage 列表收敛到 InklingCore + FilePicker + Locale<br>• 包名 `com.supernote_quicktoolbar` → `com.supernote_inkling`<br>• `PluginConfig.json` 改 ID/Key/Name/desc/icon<br>• `index.js` 留 Config Button 注册<br>• `App.tsx` 留空 home + 假 pick + 假 progress | 安装后从插件管理页能打开空白 home，点 "convert" 进 progress 屏（假数据） |
| **M1** | **JNI 通路**：<br>• `cpp/CMakeLists.txt` + `inkling_core` 空 lib<br>• `inkling_convert` 桩函数：发 4 个假 stage 进度后返回 OK<br>• Kotlin `InklingCoreModule.nativeConvert` + 进度 callback 桥到 RN event<br>• RN `InklingCoreBridge.convert()` Promise + `onProgress` 订阅 | RN 点 "convert" → 收到 4 个 stage 事件 → result 屏显示假 PDF 路径 |
| **M2** | **TXT + Markdown → 横排 PDF**：cmark + FreeType + HarfBuzz（先横排）+ libharu，输出 1920×2560 单页位图嵌入 PDF；无文字层无书签 | MD 文件能转成 PDF，能在 Supernote DOC 里打开看到字 |
| **M3** | **竖排排版**：HarfBuzz vertical-rl + paginator 横屏一分为二；libjpeg-turbo 替 PNG | 同一 MD 文件输出竖排横屏 PDF，字体边缘明显比系统渲染锐利 |
| **M4** | **文字层 + 书签**：libharu invisible text + outline；MD heading → bookmark | 在 Supernote DOC 里能选中文字、能点目录跳转 |
| **M5** | **EPUB**：libzip + libxml2 解 OPF/XHTML，转成 IR | EPUB 输入产出和 MD 一致质量的 PDF |
| **M6** | **DOCX**：复用 libzip + libxml2 解 OOXML | DOCX 输入产出 PDF |
| **M7** | **PDF 输入**：MuPDF（或 PoDoFo，看许可）提取文字层 → IR | 已有文字层的 PDF 能"重排版"成竖排版本 |
| **M8** | **4 核并行渲染**（页级线程池） + 性能调优 | 200 页 EPUB 在 RK3566 上 < 4 分钟 |
| **M9（预留）** | **桌面 CLI**：构建 `cpp/cli/main.cpp`，Linux/macOS/Windows 二进制 | `inkling input.epub output.pdf` 跑通 |

## 性能基线（M8 验收，RK3566 + 4GB）

| 文档规模 | 4 核并行 + JPEG q90 |
|---|---|
| 20 页 MD | < 30 秒 |
| 200 页 EPUB | < 4 分钟 |
| 500 页 EPUB | < 11 分钟 |

## 桌面端预留约束（M-1 起强制执行）

为了 M9 不重构，从立项起遵守：

1. `cpp/inkling/` 不允许 `#include <jni.h>` / `<android/log.h>`
2. 文件 IO 用 `std::filesystem`（C++17）
3. 对外接口 `cpp/inkling/include/inkling/api.h` 是纯 C ABI
4. 进度回调走函数指针，不用全局状态

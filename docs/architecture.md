# 架构详细设计

## 1. 层级总览

```
┌─────────────────────────────────────────────────┐
│ JS (React Native)                               │
│   App.tsx                  — screen 路由         │
│   components/InklingCoreBridge.ts  — TS 桥        │
│   components/FilePickerBridge.ts                 │
│   components/ConversionStore.ts                  │
└───────────────────────┬─────────────────────────┘
                        │ NativeModules.InklingCore
┌───────────────────────▼─────────────────────────┐
│ Android (Kotlin)                                │
│   main/java/com/supernote_inkling/              │
│     InklingCoreModule.kt   — RN ↔ JNI 桥         │
│     InklingCorePackage.kt                        │
│     FilePickerModule.kt    — SAF URI → 沙盒文件   │
│     FilePickerPackage.kt                         │
│     MainActivity.kt / MainApplication.kt         │
└───────────────────────┬─────────────────────────┘
                        │ JNI（薄）
┌───────────────────────▼─────────────────────────┐
│ Native (C/C++) —— cpp/                          │
│   inkling/   —— 平台无关核心                     │
│     parser/ layout/ render/ encode/ pdf/        │
│   jni/       —— 仅 Android 用的 JNI trampoline   │
│   cli/       —— 桌面 CLI（首期占位）              │
│   third_party/                                  │
└─────────────────────────────────────────────────┘
```

## 2. cpp/ 目录结构

```
cpp/
├── CMakeLists.txt                       # 顶层；ANDROID / DESKTOP 双 target
├── inkling/                             # 平台无关核心
│   ├── include/inkling/
│   │   ├── api.h                        # 对外 C ABI（JNI + CLI 共用）
│   │   ├── document.h                   # 中间态 IR（节点树）
│   │   └── options.h                    # 转换选项结构
│   ├── parser/
│   │   ├── txt.cpp
│   │   ├── markdown.cpp                 # cmark
│   │   ├── epub.cpp                     # libzip + libxml2
│   │   ├── docx.cpp                     # libzip + libxml2
│   │   └── pdf_text.cpp                 # MuPDF（仅读文字层）
│   ├── layout/
│   │   ├── shaper.cpp                   # HarfBuzz vertical-rl
│   │   └── paginator.cpp                # IR → pages（横屏 2560×960）
│   ├── render/
│   │   └── bitmap.cpp                   # FreeType + 自绘到位图
│   ├── encode/
│   │   └── jpeg.cpp                     # libjpeg-turbo
│   ├── pdf/
│   │   ├── writer.cpp                   # libharu，每页嵌图
│   │   ├── text_layer.cpp               # 不可见文字层（坐标对齐）
│   │   └── outline.cpp                  # 书签目录
│   ├── log.h / log.cpp                  # 日志抽象
│   └── core.cpp                         # 编排：parse → layout → render → encode → pdf
├── jni/
│   └── inkling_jni.cpp                  # 把 api.h 的 C 函数包成 JNI
├── cli/
│   └── main.cpp                         # 桌面 CLI（M9 启用）
└── third_party/                         # CMake FetchContent 拉取
    ├── cmark
    ├── freetype
    ├── harfbuzz
    ├── libzip
    ├── libxml2
    ├── libjpeg-turbo
    ├── libharu
    └── mupdf                            # 受 AGPL 约束，待决策
```

## 3. C ABI（`cpp/inkling/include/inkling/api.h`）

JNI 层和 CLI 共用同一组纯 C 函数。草拟形态：

```c
#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  INKLING_STAGE_PARSE     = 0,
  INKLING_STAGE_LAYOUT    = 1,
  INKLING_STAGE_RENDER    = 2,
  INKLING_STAGE_PACKAGE   = 3,
  INKLING_STAGE_DONE      = 4,
} inkling_stage_t;

typedef void (*inkling_progress_cb)(
    const char* job_id,
    inkling_stage_t stage,
    int percent,            /* 0..100 */
    void* userdata);

typedef enum {
  INKLING_OK                  = 0,
  INKLING_ERR_INPUT_NOT_FOUND = 1,
  INKLING_ERR_PARSE_FAILED    = 2,
  INKLING_ERR_LAYOUT_FAILED   = 3,
  INKLING_ERR_RENDER_FAILED   = 4,
  INKLING_ERR_PACKAGE_FAILED  = 5,
  INKLING_ERR_INTERNAL        = 99,
} inkling_status_t;

inkling_status_t inkling_convert(
    const char* input_path,
    const char* output_path,
    const char* options_json,    /* 由 RN 侧序列化的选项 */
    const char* job_id,
    inkling_progress_cb cb,      /* 可为 NULL */
    void* userdata);

const char* inkling_version(void);

#ifdef __cplusplus
} /* extern "C" */
#endif
```

**关键约束**：
- **纯 C**，不暴露 C++ 类型 / STL；JNI 与 CLI 都能用。
- **进度通过函数指针回调**，不用全局状态。
- **错误码通过返回值 + 详细日志**；不抛异常跨边界。

## 4. JNI 入口（`cpp/jni/inkling_jni.cpp`）

```cpp
#include <jni.h>
#include "inkling/api.h"

namespace {
  struct ProgressTrampolineCtx {
    JavaVM* vm;
    jobject globalCallback;
    jmethodID method;
  };

  void progress_trampoline(const char* jobId,
                           inkling_stage_t stage,
                           int percent,
                           void* userdata) {
    auto* ctx = static_cast<ProgressTrampolineCtx*>(userdata);
    JNIEnv* env;
    ctx->vm->AttachCurrentThread(&env, nullptr);
    jstring jJobId = env->NewStringUTF(jobId);
    env->CallVoidMethod(ctx->globalCallback, ctx->method,
                        jJobId, (jint)stage, (jint)percent);
    env->DeleteLocalRef(jJobId);
    ctx->vm->DetachCurrentThread();
  }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_supernote_1inkling_InklingCoreModule_nativeConvert(
    JNIEnv* env, jobject /*thiz*/,
    jstring jInputPath,
    jstring jOutputPath,
    jstring jOptionsJson,
    jstring jJobId,
    jobject jProgressCallback) {
  /* ... 把 jstring 转 const char*、构造 trampoline ctx、调 inkling_convert ... */
}
```

JNI 层只负责字符串/对象搬运 + 线程附加，**不写业务逻辑**。

## 5. CMake 分层

```cmake
cmake_minimum_required(VERSION 3.22)
project(inkling LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
# 各依赖通过 FetchContent_Declare + FetchContent_MakeAvailable 拉取并锁 commit

add_library(inkling_core STATIC
  inkling/core.cpp
  inkling/log.cpp
  inkling/parser/txt.cpp
  inkling/parser/markdown.cpp
  # ... M2 之后逐步加
)
target_include_directories(inkling_core PUBLIC inkling/include)
target_link_libraries(inkling_core PRIVATE
  cmark freetype harfbuzz hpdf  # M2 起所需
  # libzip libxml2 mupdf jpeg-turbo  # M5+ 加
)

if(ANDROID)
  add_library(inkling_jni SHARED jni/inkling_jni.cpp)
  target_link_libraries(inkling_jni PRIVATE inkling_core log android)
else()
  add_executable(inkling_cli cli/main.cpp)
  target_link_libraries(inkling_cli PRIVATE inkling_core)
endif()
```

Android Gradle 通过 `android { externalNativeBuild { cmake { path "cpp/CMakeLists.txt" } } }` 拉这棵树，产物 `libinkling_jni.so` 自动打进 APK。

## 6. 核心数据流（一次转换）

```
input file path
  ↓ parser/*  根据扩展名分发
inkling::Document IR (节点树：headings + paragraphs + runs[font, text])
  ↓ layout/shaper.cpp  HarfBuzz 把 runs 切成 glyph 序列（vertical-rl）
inkling::ShapedDocument
  ↓ layout/paginator.cpp  按页面尺寸切页（横屏 2560×960，纵向页一分为二）
std::vector<inkling::Page>
  ↓ render/bitmap.cpp  每页用 FreeType 画到 RGBA 位图
std::vector<Bitmap>
  ↓ encode/jpeg.cpp  libjpeg-turbo 压缩
std::vector<JpegBlob>
  ↓ pdf/writer.cpp  libharu 每页 putImage
  ↓ pdf/text_layer.cpp  在每页同坐标写不可见文字（HPDF_TextRendering_INVISIBLE）
  ↓ pdf/outline.cpp  根据 IR 的 heading 写 bookmark tree
output PDF
```

## 7. 排版关键参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| 目标分辨率 | 1920 × 2560 | 10.65" / 300 PPI |
| 单页尺寸（横屏） | 2560 × 960 | 由纵向 1920×2560 一分为二 |
| 排版方向 | vertical-rl | 从右到左，从上到下 |
| JPEG 质量 | 90 | PNG 比 JPEG 慢 3-5×，墨水屏看不出差别 |
| 文字层 | 不可见 | `HPDF_TextRendering_INVISIBLE` |
| 默认中文字体 | SourceHanSerif（思源宋体） | SIL OFL 许可，待确认 |
| 默认英文字体 | DejaVu Serif | 备选 |

## 8. 桌面端预留

第 M9 阶段启用 `cpp/cli/main.cpp`：

```cpp
int main(int argc, char** argv) {
  if (argc < 3) { fprintf(stderr, "usage: inkling INPUT OUTPUT\n"); return 1; }
  auto cb = [](const char*, inkling_stage_t s, int p, void*) {
    fprintf(stderr, "[stage=%d] %d%%\n", (int)s, p);
  };
  return inkling_convert(argv[1], argv[2], "{}", "cli-job", cb, nullptr);
}
```

CMake `if(ANDROID)` 分支以外都构建 CLI 可执行文件，Linux/macOS/Windows 各一份产物。

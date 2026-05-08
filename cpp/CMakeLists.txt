# cpp/CMakeLists.txt — platform-agnostic Inkling core.
#
# Pulls in third-party deps via FetchContent (commits pinned). Produces a
# STATIC lib `inkling_core` consumed by:
#   - main/cpp/CMakeLists.txt (Android JNI .so)
#   - cli/CMakeLists.txt      (desktop CLI, M9)
#
# Feature flags (toggle to enable/disable milestones at compile time):
#   INKLING_HAS_VERTICAL_LAYOUT (M3)
#   INKLING_HAS_TEXT_LAYER      (M4 — always on)
#   INKLING_HAS_EPUB            (M5)
#   INKLING_HAS_DOCX            (M6)
#   INKLING_HAS_PDFIN           (M7)
#   INKLING_HAS_PARALLEL        (M8)

cmake_minimum_required(VERSION 3.18.1)
project(inkling_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

option(INKLING_VERTICAL_LAYOUT "Enable vertical (CJK) layout"           ON)
option(INKLING_EPUB            "Enable EPUB input parser"               ON)
option(INKLING_DOCX            "Enable DOCX input parser"               ON)
option(INKLING_PDFIN           "Enable PDF input parser (uses MuPDF)"   ON)
option(INKLING_PARALLEL        "Enable parallel page rendering"         ON)
option(INKLING_BUILD_CLI       "Build the desktop CLI (cli/main.cpp)"   OFF)

include(FetchContent)

# ── nlohmann/json (header-only) ───────────────────────────────────────────
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG        v3.11.3
)
FetchContent_MakeAvailable(nlohmann_json)

# ── FreeType ──────────────────────────────────────────────────────────────
FetchContent_Declare(
    freetype
    GIT_REPOSITORY https://github.com/freetype/freetype.git
    GIT_TAG        VER-2-13-2
)
FetchContent_MakeAvailable(freetype)

# ── HarfBuzz ──────────────────────────────────────────────────────────────
set(HB_HAVE_FREETYPE ON CACHE BOOL "" FORCE)
FetchContent_Declare(
    harfbuzz
    GIT_REPOSITORY https://github.com/harfbuzz/harfbuzz.git
    GIT_TAG        8.5.0
)
FetchContent_MakeAvailable(harfbuzz)

# ── libjpeg-turbo ─────────────────────────────────────────────────────────
set(ENABLE_SHARED OFF CACHE BOOL "" FORCE)
set(ENABLE_STATIC ON  CACHE BOOL "" FORCE)
set(WITH_TURBOJPEG ON CACHE BOOL "" FORCE)
FetchContent_Declare(
    libjpeg_turbo
    GIT_REPOSITORY https://github.com/libjpeg-turbo/libjpeg-turbo.git
    GIT_TAG        3.0.3
)
FetchContent_MakeAvailable(libjpeg_turbo)

# ── libharu (HPDF) ────────────────────────────────────────────────────────
set(LIBHPDF_SHARED OFF CACHE BOOL "" FORCE)
set(LIBHPDF_STATIC ON  CACHE BOOL "" FORCE)
FetchContent_Declare(
    libharu
    GIT_REPOSITORY https://github.com/libharu/libharu.git
    GIT_TAG        v2.4.4
)
FetchContent_MakeAvailable(libharu)

# ── minizip-ng (M5/M6) ────────────────────────────────────────────────────
if(INKLING_EPUB OR INKLING_DOCX)
    set(MZ_FETCH_LIBS ON CACHE BOOL "" FORCE)
    set(MZ_BUILD_TESTS OFF CACHE BOOL "" FORCE)
    FetchContent_Declare(
        minizip_ng
        GIT_REPOSITORY https://github.com/zlib-ng/minizip-ng.git
        GIT_TAG        4.0.7
    )
    FetchContent_MakeAvailable(minizip_ng)
endif()

# ── pugixml (M5/M6: lightweight XML) ──────────────────────────────────────
if(INKLING_EPUB OR INKLING_DOCX)
    FetchContent_Declare(
        pugixml
        GIT_REPOSITORY https://github.com/zeux/pugixml.git
        GIT_TAG        v1.14
    )
    FetchContent_MakeAvailable(pugixml)
endif()

# ── MuPDF (M7) ───────────────────────────────────────────────────────────
# MuPDF doesn't ship a clean CMake. We assume the build host provides it
# via find_package, otherwise skip M7 transparently.
if(INKLING_PDFIN)
    find_library(MUPDF_LIB NAMES mupdf)
    find_path(MUPDF_INCLUDE NAMES mupdf/fitz.h)
    if(NOT MUPDF_LIB OR NOT MUPDF_INCLUDE)
        message(WARNING "MuPDF not found; INKLING_PDFIN disabled.")
        set(INKLING_PDFIN OFF)
    endif()
endif()

# ── inkling_core sources ──────────────────────────────────────────────────
set(INKLING_SOURCES
    inkling/api.cpp
    inkling/options.cpp
    inkling/pipeline.cpp
    inkling/parser/txt_parser.cpp
    inkling/parser/md_parser.cpp
    inkling/layout/horizontal_layout.cpp
    inkling/render/font_face.cpp
    inkling/render/page_raster.cpp
    inkling/encode/jpeg.cpp
    inkling/pdf/pdf_builder.cpp
)

if(INKLING_VERTICAL_LAYOUT)
    list(APPEND INKLING_SOURCES inkling/layout/vertical_layout.cpp)
endif()
if(INKLING_EPUB)
    list(APPEND INKLING_SOURCES inkling/parser/epub_parser.cpp inkling/util/zip_reader.cpp)
endif()
if(INKLING_DOCX)
    list(APPEND INKLING_SOURCES inkling/parser/docx_parser.cpp)
    if(NOT INKLING_EPUB)
        list(APPEND INKLING_SOURCES inkling/util/zip_reader.cpp)
    endif()
endif()
if(INKLING_PDFIN)
    list(APPEND INKLING_SOURCES inkling/parser/pdf_parser.cpp)
endif()
if(INKLING_PARALLEL)
    list(APPEND INKLING_SOURCES inkling/util/thread_pool.cpp)
endif()

add_library(inkling_core STATIC ${INKLING_SOURCES})

target_include_directories(inkling_core
    PUBLIC  ${CMAKE_CURRENT_SOURCE_DIR}/inkling/include
    PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/inkling
)

target_link_libraries(inkling_core
    PRIVATE nlohmann_json::nlohmann_json
    PRIVATE freetype
    PRIVATE harfbuzz
    PRIVATE turbojpeg-static
    PRIVATE hpdf
)

if(INKLING_VERTICAL_LAYOUT)
    target_compile_definitions(inkling_core PRIVATE INKLING_HAS_VERTICAL_LAYOUT=1)
endif()
if(INKLING_EPUB)
    target_compile_definitions(inkling_core PRIVATE INKLING_HAS_EPUB=1)
    target_link_libraries(inkling_core PRIVATE MINIZIP::minizip pugixml::pugixml)
endif()
if(INKLING_DOCX)
    target_compile_definitions(inkling_core PRIVATE INKLING_HAS_DOCX=1)
    target_link_libraries(inkling_core PRIVATE pugixml::pugixml)
endif()
if(INKLING_PDFIN)
    target_compile_definitions(inkling_core PRIVATE INKLING_HAS_PDFIN=1)
    target_include_directories(inkling_core PRIVATE ${MUPDF_INCLUDE})
    target_link_libraries(inkling_core PRIVATE ${MUPDF_LIB})
endif()
if(INKLING_PARALLEL)
    target_compile_definitions(inkling_core PRIVATE INKLING_HAS_PARALLEL=1)
    find_package(Threads REQUIRED)
    target_link_libraries(inkling_core PRIVATE Threads::Threads)
endif()

if(INKLING_BUILD_CLI)
    add_subdirectory(cli)
endif()

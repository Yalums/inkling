# cpp/CMakeLists.txt — platform-agnostic Inkling core.
#
# Produces a STATIC library `inkling_core` linkable from both:
#   - main/cpp/CMakeLists.txt (Android JNI .so)
#   - a future desktop CLI / tests target
#
# This subdirectory must NOT depend on JNI, Android NDK, SAF, or any
# platform-specific symbol. See CLAUDE.md "模块边界".

cmake_minimum_required(VERSION 3.18.1)
project(inkling_core LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_library(inkling_core STATIC
    inkling/api.cpp
)

target_include_directories(inkling_core PUBLIC
    ${CMAKE_CURRENT_SOURCE_DIR}/inkling/include
)

# Future subsystems land here (parser/layout/render/encode/pdf).
# They will be added as target_sources or sub-libraries from M2 onward.

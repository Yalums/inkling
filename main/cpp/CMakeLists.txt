# main/cpp/CMakeLists.txt — Android JNI shared library.
#
# Produces libinkling_jni.so; loaded from Kotlin via System.loadLibrary("inkling_jni").
# Pulled in from android/app/build.gradle as:
#   externalNativeBuild { cmake { path = "src/main/cpp/CMakeLists.txt" } }
# (path is relative to the Android module dir; gradle wiring lives outside this commit.)

cmake_minimum_required(VERSION 3.18.1)
project(inkling_jni LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Pull in the platform-agnostic core. Path resolves to <repo>/cpp/.
# Adjust if the Android module is restructured to a different depth.
add_subdirectory(
    ${CMAKE_CURRENT_SOURCE_DIR}/../../cpp
    ${CMAKE_CURRENT_BINARY_DIR}/inkling_core
)

add_library(inkling_jni SHARED
    jni_bridge.cpp
)

target_link_libraries(inkling_jni
    PRIVATE inkling_core
    PRIVATE log
)

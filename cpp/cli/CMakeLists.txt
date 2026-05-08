# cpp/cli/CMakeLists.txt — desktop CLI driver.
# Built when -DINKLING_BUILD_CLI=ON is passed at configure time.

add_executable(inkling-cli main.cpp)
target_link_libraries(inkling-cli PRIVATE inkling_core)
target_compile_features(inkling-cli PRIVATE cxx_std_17)

/**
 * api.cpp — Inkling C ABI implementation (M1 stub).
 *
 * Emits four pipeline stages in order with a short delay between each, then
 * INK_STAGE_DONE. No real parsing/layout/rendering yet — those land in M2+.
 *
 * Why a stub still: M1's verification is "logcat sees cpp output AND RN
 * receives progress events", proving the JNI ↔ C++ ↔ progress callback ↔
 * Kotlin trampoline ↔ DeviceEventEmitter ↔ JS chain end-to-end.
 */
#include "inkling/api.h"

#include <chrono>
#include <thread>

namespace {

constexpr const char* kVersion = "0.1.0-m1";

void emit_progress(ink_progress_cb cb, void* userdata,
                   const char* job_id, ink_stage_t stage, int percent) {
    if (cb) cb(job_id, static_cast<int>(stage), percent, userdata);
}

void emit_log(ink_log_cb cb, void* userdata,
              ink_log_level_t level, const char* tag, const char* msg) {
    if (cb) cb(static_cast<int>(level), tag, msg, userdata);
}

}  // namespace

extern "C" {

const char* ink_version(void) {
    return kVersion;
}

ink_status_t ink_convert(const char*      input_path,
                         const char*      output_path,
                         const char*      options_json,
                         const char*      job_id,
                         ink_progress_cb  progress,
                         void*            progress_userdata,
                         ink_log_cb       log,
                         void*            log_userdata) {
    (void)options_json;

    if (!input_path || !output_path || !job_id) {
        emit_log(log, log_userdata, INK_LOG_ERROR, "inkling",
                 "ink_convert: NULL input/output/job_id");
        return INK_ERR_INVALID_OPTIONS;
    }

    emit_log(log, log_userdata, INK_LOG_INFO, "inkling",
             "ink_convert (M1 stub) starting");

    constexpr ink_stage_t stages[] = {
        INK_STAGE_PARSE, INK_STAGE_LAYOUT, INK_STAGE_RENDER, INK_STAGE_PACKAGE
    };
    for (ink_stage_t s : stages) {
        emit_progress(progress, progress_userdata, job_id, s, 100);
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
    }
    emit_progress(progress, progress_userdata, job_id, INK_STAGE_DONE, 100);

    emit_log(log, log_userdata, INK_LOG_INFO, "inkling",
             "ink_convert (M1 stub) finished OK");
    return INK_OK;
}

}  // extern "C"

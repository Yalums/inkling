#include "include/inkling/api.h"

#include <filesystem>
#include <string>

#include "logger.h"
#include "options.h"
#include "pipeline.h"

namespace {

constexpr const char* kVersion = "0.1.0-m8";

struct CallbackLogger : public inkling::Logger {
    ink_log_cb cb;
    void* ud;
    CallbackLogger(ink_log_cb c, void* u) : cb(c), ud(u) {}
    void log(inkling::LogLevel lvl, const char* tag, const char* msg) override {
        if (!cb) return;
        cb((int)lvl, tag, msg, ud);
    }
};

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
    if (!input_path || !output_path || !job_id) return INK_ERR_INVALID_OPTIONS;

    CallbackLogger cbLog(log, log_userdata);

    inkling::Options opts;
    std::string err;
    if (!inkling::parseOptions(options_json ? options_json : "", &opts, &err)) {
        cbLog.log(inkling::LogLevel::Error, "inkling", err.c_str());
        return INK_ERR_INVALID_OPTIONS;
    }

    return inkling::runPipeline(std::filesystem::path(input_path),
                                std::filesystem::path(output_path),
                                opts, job_id,
                                progress, progress_userdata,
                                &cbLog);
}

}  // extern "C"

#ifndef INKLING_PIPELINE_H_
#define INKLING_PIPELINE_H_

#include <filesystem>

#include "include/inkling/api.h"
#include "logger.h"
#include "options.h"

namespace inkling {

// Run the full convert pipeline. Stages emitted via `progressCb` if non-null.
ink_status_t runPipeline(const std::filesystem::path& input,
                         const std::filesystem::path& output,
                         const Options& opts,
                         const char* jobId,
                         ink_progress_cb progressCb,
                         void* progressUserdata,
                         Logger* log);

}  // namespace inkling

#endif

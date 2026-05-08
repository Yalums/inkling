/**
 * inkling/api.h — Inkling C ABI (platform-agnostic, JNI- and CLI-callable).
 *
 * This is the ONLY header allowed across the language boundary. It contains:
 *   - Status codes (ink_status_t)
 *   - Pipeline stages (ink_stage_t) for progress reporting
 *   - Function pointer typedefs for progress + log callbacks
 *   - The single entry point ink_convert()
 *
 * Implementation rules (see CLAUDE.md "模块边界"):
 *   1. cpp/inkling/ MUST NOT include <jni.h> or <android/log.h>.
 *   2. File IO uses std::filesystem; no Android AAsset*.
 *   3. Progress is delivered through ink_progress_cb; the Android side wraps
 *      the call site in a JNI trampoline; the desktop CLI side prints to stderr.
 */
#ifndef INKLING_API_H_
#define INKLING_API_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    INK_OK                  = 0,
    INK_ERR_OPEN_INPUT      = 1,
    INK_ERR_PARSE           = 2,
    INK_ERR_LAYOUT          = 3,
    INK_ERR_RENDER          = 4,
    INK_ERR_ENCODE          = 5,
    INK_ERR_WRITE_OUTPUT    = 6,
    INK_ERR_INVALID_OPTIONS = 7,
    INK_ERR_INTERNAL        = 99
} ink_status_t;

typedef enum {
    INK_STAGE_PARSE   = 0,
    INK_STAGE_LAYOUT  = 1,
    INK_STAGE_RENDER  = 2,
    INK_STAGE_PACKAGE = 3,
    INK_STAGE_DONE    = 4
} ink_stage_t;

typedef enum {
    INK_LOG_DEBUG = 0,
    INK_LOG_INFO  = 1,
    INK_LOG_WARN  = 2,
    INK_LOG_ERROR = 3
} ink_log_level_t;

/** Progress callback. percent is 0..100 within the given stage. */
typedef void (*ink_progress_cb)(const char* job_id,
                                int          stage,
                                int          percent,
                                void*        userdata);

/** Log callback. tag/msg are NUL-terminated UTF-8. */
typedef void (*ink_log_cb)(int          level,
                           const char*  tag,
                           const char*  msg,
                           void*        userdata);

/**
 * Convert a single document.
 *
 * @param input_path        Absolute path to input (txt/md/epub/docx/pdf).
 * @param output_path       Absolute path for output PDF (will be overwritten).
 * @param options_json      UTF-8 JSON. Schema TBD per milestone (M2+ extends).
 * @param job_id            Caller-chosen identifier; echoed in progress events.
 * @param progress          Optional. NULL silences progress reporting.
 * @param progress_userdata Opaque pointer passed unchanged to progress.
 * @param log               Optional. NULL silences logging.
 * @param log_userdata      Opaque pointer passed unchanged to log.
 *
 * @return INK_OK on success; otherwise an ink_status_t error code.
 */
ink_status_t ink_convert(const char*      input_path,
                         const char*      output_path,
                         const char*      options_json,
                         const char*      job_id,
                         ink_progress_cb  progress,
                         void*            progress_userdata,
                         ink_log_cb       log,
                         void*            log_userdata);

/** Returns a static, NUL-terminated semver-ish string. Never NULL. */
const char* ink_version(void);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // INKLING_API_H_

// inkling-cli — desktop entry point that exercises the same C ABI the
// Android JNI bridge calls. Useful for regression testing on a workstation
// without the device. Progress is printed to stderr; the resulting PDF is
// written to the specified path.
//
// Usage:
//   inkling-cli --input <path> --output <path> --font <font.ttf>
//               [--font-bold <p>] [--font-mono <p>]
//               [--vertical] [--split-landscape]
//               [--page-width N] [--page-height N]
//               [--font-size N] [--quality N] [--threads N]
//               [--no-text-layer] [--no-bookmarks]

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "inkling/api.h"

namespace {

const char* stageName(int s) {
    switch (s) {
        case INK_STAGE_PARSE:   return "parse";
        case INK_STAGE_LAYOUT:  return "layout";
        case INK_STAGE_RENDER:  return "render";
        case INK_STAGE_PACKAGE: return "package";
        case INK_STAGE_DONE:    return "done";
    }
    return "?";
}

void onProgress(const char* jobId, int stage, int percent, void*) {
    std::fprintf(stderr, "[%s] %s %d%%\n", jobId, stageName(stage), percent);
}

void onLog(int level, const char* tag, const char* msg, void*) {
    const char* lvl = "I";
    switch (level) {
        case 0: lvl = "D"; break;
        case 1: lvl = "I"; break;
        case 2: lvl = "W"; break;
        case 3: lvl = "E"; break;
    }
    std::fprintf(stderr, "  [%s/%s] %s\n", lvl, tag ? tag : "?", msg ? msg : "");
}

struct Args {
    std::string input;
    std::string output;
    std::string font;
    std::string fontBold;
    std::string fontMono;
    int    pageWidth   = 1920;
    int    pageHeight  = 2560;
    double fontSize    = 22.0;
    int    quality     = 90;
    int    threads     = 0;
    bool   vertical    = false;
    bool   splitLandscape = false;
    bool   embedTextLayer = true;
    bool   embedBookmarks = true;
};

void usage() {
    std::fputs(
        "usage: inkling-cli --input <path> --output <path> --font <ttf>\n"
        "                   [--font-bold <p>] [--font-mono <p>]\n"
        "                   [--vertical] [--split-landscape]\n"
        "                   [--page-width N] [--page-height N]\n"
        "                   [--font-size N] [--quality N] [--threads N]\n"
        "                   [--no-text-layer] [--no-bookmarks]\n",
        stderr);
}

bool parseArgs(int argc, char** argv, Args* out) {
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto need = [&](std::string* dst) -> bool {
            if (i + 1 >= argc) return false;
            *dst = argv[++i];
            return true;
        };
        auto needI = [&](int* dst) -> bool {
            if (i + 1 >= argc) return false;
            *dst = std::atoi(argv[++i]);
            return true;
        };
        auto needD = [&](double* dst) -> bool {
            if (i + 1 >= argc) return false;
            *dst = std::atof(argv[++i]);
            return true;
        };

        if      (a == "--input")          { if (!need(&out->input))     return false; }
        else if (a == "--output")         { if (!need(&out->output))    return false; }
        else if (a == "--font")           { if (!need(&out->font))      return false; }
        else if (a == "--font-bold")      { if (!need(&out->fontBold))  return false; }
        else if (a == "--font-mono")      { if (!need(&out->fontMono))  return false; }
        else if (a == "--page-width")     { if (!needI(&out->pageWidth))  return false; }
        else if (a == "--page-height")    { if (!needI(&out->pageHeight)) return false; }
        else if (a == "--font-size")      { if (!needD(&out->fontSize))   return false; }
        else if (a == "--quality")        { if (!needI(&out->quality))    return false; }
        else if (a == "--threads")        { if (!needI(&out->threads))    return false; }
        else if (a == "--vertical")       { out->vertical = true; }
        else if (a == "--split-landscape"){ out->splitLandscape = true; }
        else if (a == "--no-text-layer")  { out->embedTextLayer = false; }
        else if (a == "--no-bookmarks")   { out->embedBookmarks = false; }
        else if (a == "-h" || a == "--help") { return false; }
        else { std::fprintf(stderr, "unknown arg: %s\n", a.c_str()); return false; }
    }
    return !out->input.empty() && !out->output.empty() && !out->font.empty();
}

std::string buildOptionsJson(const Args& a) {
    auto esc = [](const std::string& s) {
        std::string o;
        o.reserve(s.size() + 2);
        for (char c : s) {
            if (c == '"' || c == '\\') o.push_back('\\');
            o.push_back(c);
        }
        return o;
    };
    char buf[2048];
    std::snprintf(buf, sizeof(buf),
        "{\"fontPath\":\"%s\",\"fontPathBold\":\"%s\",\"fontPathMono\":\"%s\","
        "\"pageWidth\":%d,\"pageHeight\":%d,\"fontSize\":%.2f,"
        "\"jpegQuality\":%d,\"threadCount\":%d,"
        "\"orientation\":\"%s\",\"splitLandscape\":%s,"
        "\"embedTextLayer\":%s,\"embedBookmarks\":%s}",
        esc(a.font).c_str(), esc(a.fontBold).c_str(), esc(a.fontMono).c_str(),
        a.pageWidth, a.pageHeight, a.fontSize,
        a.quality, a.threads,
        a.vertical ? "vertical-rtl" : "horizontal",
        a.splitLandscape ? "true" : "false",
        a.embedTextLayer ? "true" : "false",
        a.embedBookmarks ? "true" : "false");
    return buf;
}

}  // namespace

int main(int argc, char** argv) {
    Args args;
    if (!parseArgs(argc, argv, &args)) {
        usage();
        return 2;
    }

    std::string opts = buildOptionsJson(args);
    std::fprintf(stderr, "inkling-cli %s\n", ink_version());
    std::fprintf(stderr, "input:  %s\n", args.input.c_str());
    std::fprintf(stderr, "output: %s\n", args.output.c_str());

    ink_status_t st = ink_convert(args.input.c_str(),
                                  args.output.c_str(),
                                  opts.c_str(),
                                  "cli",
                                  &onProgress, nullptr,
                                  &onLog,      nullptr);
    if (st != INK_OK) {
        std::fprintf(stderr, "convert failed: %d\n", (int)st);
        return (int)st;
    }
    return 0;
}

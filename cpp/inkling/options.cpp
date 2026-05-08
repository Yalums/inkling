#include "options.h"

#include <nlohmann/json.hpp>

namespace inkling {

namespace {

template <typename T>
void readIfPresent(const nlohmann::json& obj, const char* key, T& out) {
    auto it = obj.find(key);
    if (it != obj.end() && !it->is_null()) {
        try { out = it->get<T>(); } catch (...) {}
    }
}

}  // namespace

bool parseOptions(const std::string& jsonStr, Options* out, std::string* errMsg) {
    if (!out) return false;
    if (jsonStr.empty()) return true;  // defaults are fine

    nlohmann::json j;
    try {
        j = nlohmann::json::parse(jsonStr);
    } catch (const std::exception& e) {
        if (errMsg) *errMsg = std::string("json parse: ") + e.what();
        return false;
    }
    if (!j.is_object()) {
        if (errMsg) *errMsg = "options json must be an object";
        return false;
    }

    readIfPresent(j, "fontPath",       out->fontPath);
    readIfPresent(j, "fontPathBold",   out->fontPathBold);
    readIfPresent(j, "fontPathMono",   out->fontPathMono);
    readIfPresent(j, "pageWidth",      out->pageWidth);
    readIfPresent(j, "pageHeight",     out->pageHeight);
    readIfPresent(j, "marginTop",      out->marginTop);
    readIfPresent(j, "marginRight",    out->marginRight);
    readIfPresent(j, "marginBottom",   out->marginBottom);
    readIfPresent(j, "marginLeft",     out->marginLeft);
    readIfPresent(j, "fontSize",       out->fontSize);
    readIfPresent(j, "lineHeightMul",  out->lineHeightMul);
    readIfPresent(j, "paragraphSpacing", out->paragraphSpacing);
    readIfPresent(j, "jpegQuality",    out->jpegQuality);
    readIfPresent(j, "threadCount",    out->threadCount);
    readIfPresent(j, "embedTextLayer", out->embedTextLayer);
    readIfPresent(j, "embedBookmarks", out->embedBookmarks);
    readIfPresent(j, "splitLandscape", out->splitLandscape);

    auto hsIt = j.find("headingScale");
    if (hsIt != j.end() && hsIt->is_array()) {
        for (size_t i = 0; i < hsIt->size() && i < 6; ++i) {
            try { out->headingScale[i] = (*hsIt)[i].get<double>(); } catch (...) {}
        }
    }

    auto orIt = j.find("orientation");
    if (orIt != j.end() && orIt->is_string()) {
        const auto s = orIt->get<std::string>();
        if (s == "vertical-rtl" || s == "verticalRtl" || s == "vertical") {
            out->orientation = Orientation::VerticalRtl;
        } else {
            out->orientation = Orientation::HorizontalLtr;
        }
    }

    return true;
}

}  // namespace inkling

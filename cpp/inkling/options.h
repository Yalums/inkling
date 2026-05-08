#ifndef INKLING_OPTIONS_H_
#define INKLING_OPTIONS_H_

#include <string>

namespace inkling {

enum class Orientation {
    HorizontalLtr,
    VerticalRtl,
};

struct Options {
    std::string fontPath;
    std::string fontPathBold;
    std::string fontPathMono;

    int pageWidth    = 1920;
    int pageHeight   = 2560;
    int marginTop    = 80;
    int marginRight  = 80;
    int marginBottom = 80;
    int marginLeft   = 80;

    double fontSize       = 22.0;
    double lineHeightMul  = 1.6;
    double headingScale[6] = {32.0, 28.0, 26.0, 24.0, 22.0, 20.0};
    double paragraphSpacing = 6.0;

    Orientation orientation = Orientation::HorizontalLtr;
    bool        splitLandscape = false;     // M3: split a portrait page into two halves

    int  jpegQuality = 90;
    int  threadCount = 0;                   // 0 = auto, used in M8

    bool embedTextLayer = true;             // M4
    bool embedBookmarks = true;             // M4
};

bool parseOptions(const std::string& json, Options* out, std::string* errMsg);

}  // namespace inkling

#endif  // INKLING_OPTIONS_H_

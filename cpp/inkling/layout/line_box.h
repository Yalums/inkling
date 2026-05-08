#ifndef INKLING_LAYOUT_LINE_BOX_H_
#define INKLING_LAYOUT_LINE_BOX_H_

#include <cstdint>
#include <string>
#include <vector>

namespace inkling {

enum class FontSlot : uint8_t {
    Regular = 0,
    Bold    = 1,
    Mono    = 2,
};

struct PlacedGlyph {
    uint32_t    glyphIndex;
    float       x;
    float       y;
    float       advance;
    FontSlot    fontSlot;
    float       fontPx;
    std::string sourceUtf8;     // the UTF-8 substring this glyph cluster covers
};

struct PageGlyphs {
    int                       pageNumber = 0;     // 1-based; assigned at flush
    std::vector<PlacedGlyph>  glyphs;

    struct TextSpan {
        std::string utf8;
        float x, y, w, h;
    };
    std::vector<TextSpan>     textSpans;
};

struct HeadingAnchor {
    std::string title;
    int         level;
    int         pageIndex0;
    float       yOnPage;
};

}  // namespace inkling

#endif

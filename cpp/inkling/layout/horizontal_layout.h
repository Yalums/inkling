#ifndef INKLING_LAYOUT_HORIZONTAL_LAYOUT_H_
#define INKLING_LAYOUT_HORIZONTAL_LAYOUT_H_

#include <memory>
#include <vector>

#include "../document.h"
#include "../logger.h"
#include "../options.h"
#include "line_box.h"

namespace inkling {

class FontFace;  // render/font_face.h

struct LayoutResult {
    std::vector<PageGlyphs>     pages;
    std::vector<HeadingAnchor>  headings;
};

class HorizontalLayout {
public:
    // `fonts` is indexed by FontSlot.
    HorizontalLayout(const Options& opts, FontFace* regular, FontFace* bold,
                     FontFace* mono, Logger* log);
    ~HorizontalLayout();
    HorizontalLayout(const HorizontalLayout&) = delete;
    HorizontalLayout& operator=(const HorizontalLayout&) = delete;

    LayoutResult run(const Document& doc);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace inkling

#endif

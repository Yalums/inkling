#ifndef INKLING_LAYOUT_VERTICAL_LAYOUT_H_
#define INKLING_LAYOUT_VERTICAL_LAYOUT_H_

#include <memory>

#include "../document.h"
#include "../logger.h"
#include "../options.h"
#include "horizontal_layout.h"
#include "line_box.h"

namespace inkling {

class FontFace;

// Right-to-left columns; top-to-bottom glyphs within a column.
// Used for traditional CJK layout. Honors splitLandscape: when the option is
// set, the pipeline supplies pageWidth/pageHeight already swapped to the
// half-page landscape geometry (e.g. 2560 × 960), and this layout simply
// fills it column-major.
class VerticalLayout {
public:
    VerticalLayout(const Options& opts, FontFace* regular, FontFace* bold,
                   FontFace* mono, Logger* log);
    ~VerticalLayout();
    VerticalLayout(const VerticalLayout&) = delete;
    VerticalLayout& operator=(const VerticalLayout&) = delete;

    LayoutResult run(const Document& doc);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace inkling

#endif

#ifndef INKLING_LAYOUT_GEOMETRY_H_
#define INKLING_LAYOUT_GEOMETRY_H_

#include "../options.h"

namespace inkling {

struct PageGeometry {
    int width;
    int height;
    int marginTop;
    int marginRight;
    int marginBottom;
    int marginLeft;

    int contentWidth()  const { return width  - marginLeft - marginRight; }
    int contentHeight() const { return height - marginTop  - marginBottom; }
};

inline PageGeometry geometryFromOptions(const Options& o) {
    return PageGeometry{
        o.pageWidth, o.pageHeight,
        o.marginTop, o.marginRight, o.marginBottom, o.marginLeft
    };
}

}  // namespace inkling

#endif

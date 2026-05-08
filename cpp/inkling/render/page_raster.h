#ifndef INKLING_RENDER_PAGE_RASTER_H_
#define INKLING_RENDER_PAGE_RASTER_H_

#include <cstdint>
#include <vector>

#include "../layout/line_box.h"
#include "../logger.h"
#include "../options.h"

namespace inkling {

class FontFace;

// 8-bit grayscale framebuffer; 0=black, 255=white.
struct Bitmap8 {
    int width  = 0;
    int height = 0;
    std::vector<uint8_t> pixels;     // row-major, stride = width

    void clearWhite() {
        std::fill(pixels.begin(), pixels.end(), uint8_t(255));
    }
};

class PageRaster {
public:
    PageRaster(const Options& opts, FontFace* regular, FontFace* bold,
               FontFace* mono, Logger* log);

    // Render a single page into `out`. `out` is sized to the page dimensions
    // and cleared to white before glyphs are rasterised.
    bool render(const PageGlyphs& page, Bitmap8* out);

private:
    const Options& opts_;
    FontFace* regular_;
    FontFace* bold_;
    FontFace* mono_;
    Logger*   log_;
};

}  // namespace inkling

#endif

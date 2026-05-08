#include "page_raster.h"

#include <algorithm>

#include "font_face.h"

namespace inkling {

namespace {

void blit(Bitmap8& dst, const FontFace::Glyph& g, int penX, int penY) {
    // Place glyph so that (penX, penY) corresponds to the baseline pen position.
    int x0 = penX + g.bearingLeft;
    int y0 = penY - g.bearingTop;
    for (int j = 0; j < g.height; ++j) {
        int dy = y0 + j;
        if (dy < 0 || dy >= dst.height) continue;
        for (int i = 0; i < g.width; ++i) {
            int dx = x0 + i;
            if (dx < 0 || dx >= dst.width) continue;
            uint8_t cov = g.pixels[j * g.width + i];
            if (cov == 0) continue;
            // dst is white(255); glyph coverage darkens.
            // out = bg * (1 - cov/255) + 0 * (cov/255) = bg * (255-cov)/255
            uint8_t* px = &dst.pixels[dy * dst.width + dx];
            uint16_t bg = *px;
            uint16_t darkened = (bg * (255 - cov)) / 255;
            *px = (uint8_t)std::min<uint16_t>(*px, (uint8_t)darkened);
        }
    }
}

}  // namespace

PageRaster::PageRaster(const Options& opts, FontFace* r, FontFace* b,
                       FontFace* m, Logger* log)
    : opts_(opts), regular_(r), bold_(b), mono_(m), log_(log) {}

bool PageRaster::render(const PageGlyphs& page, Bitmap8* out) {
    if (!out) return false;
    out->width = opts_.pageWidth;
    out->height = opts_.pageHeight;
    out->pixels.assign((size_t)out->width * out->height, uint8_t(255));

    for (const auto& g : page.glyphs) {
        FontFace* face = nullptr;
        switch (g.fontSlot) {
            case FontSlot::Bold: face = bold_ ? bold_ : regular_; break;
            case FontSlot::Mono: face = mono_ ? mono_ : regular_; break;
            default:             face = regular_;
        }
        if (!face) continue;

        FontFace::Glyph rg;
        if (!face->renderGlyph(g.glyphIndex, g.fontPx, &rg)) continue;
        blit(*out, rg, (int)(g.x + 0.5f), (int)(g.y + 0.5f));
    }
    return true;
}

}  // namespace inkling

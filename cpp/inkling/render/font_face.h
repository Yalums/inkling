#ifndef INKLING_RENDER_FONT_FACE_H_
#define INKLING_RENDER_FONT_FACE_H_

#include <cstdint>
#include <memory>
#include <string>

namespace inkling {

class FontFace {
public:
    FontFace();
    ~FontFace();
    FontFace(const FontFace&) = delete;
    FontFace& operator=(const FontFace&) = delete;

    bool open(const std::string& path);
    bool isOpen() const;

    // Set the active size in pixels. Required before shaping or rasterising.
    bool setPixelSize(double px);

    // Native handles for HarfBuzz / FreeType callers. Opaque.
    void* freetypeFace() const;       // FT_Face (cast at call site)
    void* harfbuzzFont(double px);    // hb_font_t* sized to `px`; cached.

    // Raster a glyph into an 8-bit grayscale bitmap. Caller frees.
    struct Glyph {
        int width = 0;
        int height = 0;
        int bearingLeft = 0;
        int bearingTop  = 0;
        int advance     = 0;
        std::vector<uint8_t> pixels;  // height × width, row-major
    };
    bool renderGlyph(uint32_t glyphIndex, double px, Glyph* out);

    // Vertical metrics in pixels at the given size.
    double ascender(double px) const;
    double descender(double px) const;
    double lineGap(double px) const;
    double lineHeight(double px) const { return ascender(px) - descender(px) + lineGap(px); }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace inkling

#endif

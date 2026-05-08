#include "font_face.h"

#include <unordered_map>
#include <vector>

#include <ft2build.h>
#include FT_FREETYPE_H

#include <hb.h>
#include <hb-ft.h>

namespace inkling {

namespace {

class FtLibrary {
public:
    FtLibrary() { FT_Init_FreeType(&lib_); }
    ~FtLibrary() { if (lib_) FT_Done_FreeType(lib_); }
    FT_Library handle() const { return lib_; }
private:
    FT_Library lib_ = nullptr;
};

FtLibrary& ft() {
    static FtLibrary g;
    return g;
}

}  // namespace

struct FontFace::Impl {
    FT_Face   face = nullptr;
    double    pxCurrent = 0.0;
    std::unordered_map<int, hb_font_t*> hbCache;  // size_in_64th_px → hb_font

    ~Impl() {
        for (auto& kv : hbCache) {
            if (kv.second) hb_font_destroy(kv.second);
        }
        if (face) FT_Done_Face(face);
    }
};

FontFace::FontFace() : impl_(std::make_unique<Impl>()) {}
FontFace::~FontFace() = default;

bool FontFace::open(const std::string& path) {
    if (FT_New_Face(ft().handle(), path.c_str(), 0, &impl_->face)) {
        impl_->face = nullptr;
        return false;
    }
    return true;
}

bool FontFace::isOpen() const { return impl_->face != nullptr; }

bool FontFace::setPixelSize(double px) {
    if (!impl_->face) return false;
    if (FT_Set_Pixel_Sizes(impl_->face, 0, static_cast<FT_UInt>(px + 0.5))) return false;
    impl_->pxCurrent = px;
    return true;
}

void* FontFace::freetypeFace() const { return impl_->face; }

void* FontFace::harfbuzzFont(double px) {
    if (!impl_->face) return nullptr;
    int key = static_cast<int>(px * 64.0 + 0.5);
    auto it = impl_->hbCache.find(key);
    if (it != impl_->hbCache.end()) return it->second;

    FT_Set_Pixel_Sizes(impl_->face, 0, static_cast<FT_UInt>(px + 0.5));
    hb_font_t* hbf = hb_ft_font_create_referenced(impl_->face);
    hb_ft_font_set_funcs(hbf);
    impl_->hbCache.emplace(key, hbf);
    return hbf;
}

bool FontFace::renderGlyph(uint32_t glyphIndex, double px, Glyph* out) {
    if (!impl_->face || !out) return false;
    if (impl_->pxCurrent != px) setPixelSize(px);

    if (FT_Load_Glyph(impl_->face, glyphIndex, FT_LOAD_DEFAULT)) return false;
    if (FT_Render_Glyph(impl_->face->glyph, FT_RENDER_MODE_NORMAL)) return false;

    FT_Bitmap& bm = impl_->face->glyph->bitmap;
    out->width  = bm.width;
    out->height = bm.rows;
    out->bearingLeft = impl_->face->glyph->bitmap_left;
    out->bearingTop  = impl_->face->glyph->bitmap_top;
    out->advance     = impl_->face->glyph->advance.x >> 6;
    out->pixels.assign(bm.buffer, bm.buffer + bm.rows * bm.pitch);
    return true;
}

double FontFace::ascender(double px) const {
    if (!impl_->face) return 0;
    double upem = impl_->face->units_per_EM;
    return upem ? (impl_->face->ascender * px / upem) : px;
}
double FontFace::descender(double px) const {
    if (!impl_->face) return 0;
    double upem = impl_->face->units_per_EM;
    return upem ? (impl_->face->descender * px / upem) : 0;
}
double FontFace::lineGap(double px) const {
    if (!impl_->face) return 0;
    double upem = impl_->face->units_per_EM;
    double gap  = (double)impl_->face->height - (impl_->face->ascender - impl_->face->descender);
    return upem ? (gap * px / upem) : 0;
}

}  // namespace inkling

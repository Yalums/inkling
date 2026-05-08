#include "vertical_layout.h"

#include <algorithm>
#include <cstring>

#include <hb.h>

#include "../render/font_face.h"
#include "geometry.h"

namespace inkling {

namespace {

uint32_t utf8At(const std::string& s, int byteOffset) {
    if (byteOffset < 0 || byteOffset >= (int)s.size()) return 0;
    uint8_t b = (uint8_t)s[byteOffset];
    if (b < 0x80) return b;
    int extra;
    uint32_t cp;
    if      ((b & 0xE0) == 0xC0) { extra = 1; cp = b & 0x1F; }
    else if ((b & 0xF0) == 0xE0) { extra = 2; cp = b & 0x0F; }
    else if ((b & 0xF8) == 0xF0) { extra = 3; cp = b & 0x07; }
    else                          { return 0; }
    int p = byteOffset + 1;
    while (extra-- > 0) {
        if (p >= (int)s.size() || ((uint8_t)s[p] & 0xC0) != 0x80) return cp;
        cp = (cp << 6) | ((uint8_t)s[p] & 0x3F);
        ++p;
    }
    return cp;
}

bool isCjk(uint32_t cp) {
    if (cp >= 0x3000 && cp <= 0x303F) return true;
    if (cp >= 0x3040 && cp <= 0x30FF) return true;
    if (cp >= 0x3400 && cp <= 0x4DBF) return true;
    if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
    if (cp >= 0xF900 && cp <= 0xFAFF) return true;
    if (cp >= 0xFF00 && cp <= 0xFFEF) return true;
    return false;
}

struct VGlyph {
    PlacedGlyph g;
    bool        breakAfter   = false;
    bool        isWhitespace = false;
};

void shapeRunVertical(const std::string& text, FontFace* face, FontSlot slot,
                      double px, std::vector<VGlyph>& out) {
    if (!face || !face->isOpen() || text.empty()) return;

    hb_buffer_t* buf = hb_buffer_create();
    hb_buffer_add_utf8(buf, text.c_str(), (int)text.size(), 0, (int)text.size());
    hb_buffer_set_direction(buf, HB_DIRECTION_TTB);
    hb_buffer_guess_segment_properties(buf);

    hb_font_t* hbf = (hb_font_t*)face->harfbuzzFont(px);
    hb_shape(hbf, buf, nullptr, 0);

    unsigned int n = 0;
    hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &n);
    hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &n);

    for (unsigned i = 0; i < n; ++i) {
        VGlyph vg{};
        vg.g.glyphIndex = info[i].codepoint;
        vg.g.x = pos[i].x_offset / 64.0f;
        vg.g.y = 0;
        // For TTB direction, advance is y_advance.
        vg.g.advance = (-pos[i].y_advance) / 64.0f;
        if (vg.g.advance == 0) vg.g.advance = (float)px;       // fallback to em
        vg.g.fontSlot = slot;
        vg.g.fontPx = (float)px;

        int byteStart = (int)info[i].cluster;
        int byteEnd   = (i + 1 < n) ? (int)info[i + 1].cluster : (int)text.size();
        if (byteEnd > byteStart && byteEnd <= (int)text.size()) {
            vg.g.sourceUtf8 = text.substr(byteStart, byteEnd - byteStart);
        }

        uint32_t cp = utf8At(text, byteStart);
        vg.isWhitespace = (cp == ' ' || cp == '\t' || cp == 0x00A0);
        // Every CJK ideograph and every space is a column-break opportunity.
        vg.breakAfter = vg.isWhitespace || isCjk(cp);

        out.push_back(vg);
    }
    hb_buffer_destroy(buf);
}

double slotPx(const Options& opts, const Block& b, FontSlot s) {
    double base = opts.fontSize;
    if (b.kind == BlockKind::Heading && b.level >= 1 && b.level <= 6) {
        base = opts.headingScale[b.level - 1];
    }
    if (b.kind == BlockKind::CodeBlock || s == FontSlot::Mono) {
        base = std::max(base * 0.95, 12.0);
    }
    return base;
}

FontSlot slotForRun(const Block& b, const InlineRun& r) {
    if (b.kind == BlockKind::CodeBlock) return FontSlot::Mono;
    if (r.kind == InlineKind::Code)     return FontSlot::Mono;
    if (r.kind == InlineKind::Strong)   return FontSlot::Bold;
    if (b.kind == BlockKind::Heading)   return FontSlot::Bold;
    return FontSlot::Regular;
}

}  // namespace

struct VerticalLayout::Impl {
    Options       opts;
    PageGeometry  geo;
    FontFace*     regular;
    FontFace*     bold;
    FontFace*     mono;
    Logger*       log;

    LayoutResult  result;
    PageGlyphs    currentPage;

    // Vertical rl: penX shrinks left as columns advance; penY grows down.
    float penX;             // current column's center x
    float penY;             // y of next glyph in column
    float colWidth;
    int   pageIdx0;

    Impl(const Options& o, FontFace* r, FontFace* b, FontFace* m, Logger* l)
        : opts(o), geo(geometryFromOptions(o)), regular(r), bold(b), mono(m),
          log(l), pageIdx0(0) {
        colWidth = (float)opts.fontSize * (float)opts.lineHeightMul;
        resetPagePen();
        currentPage.pageNumber = 1;
    }

    FontFace* faceFor(FontSlot s) {
        switch (s) {
            case FontSlot::Bold: return bold ? bold : regular;
            case FontSlot::Mono: return mono ? mono : regular;
            default:             return regular;
        }
    }

    void resetPagePen() {
        // Start at the rightmost column, top.
        penX = (float)(geo.width - geo.marginRight) - colWidth * 0.5f;
        penY = (float)geo.marginTop;
    }

    void newPage() {
        result.pages.push_back(std::move(currentPage));
        ++pageIdx0;
        currentPage = PageGlyphs{};
        currentPage.pageNumber = pageIdx0 + 1;
        resetPagePen();
    }

    void newColumn() {
        penX -= colWidth;
        penY = (float)geo.marginTop;
        if (penX - colWidth * 0.5f < (float)geo.marginLeft) {
            newPage();
        }
    }

    // Place glyphs in [from..to] inclusive into a single column starting at
    // (penX, penY). Updates penY. Adds a textSpan covering the column slice.
    void emitColumnSlice(std::vector<VGlyph>& glyphs, size_t from, size_t to) {
        if (from > to || from >= glyphs.size()) return;
        const float colTop = penY;
        std::string utf8;
        for (size_t i = from; i <= to; ++i) {
            VGlyph& vg = glyphs[i];
            // Center the glyph horizontally in the column.
            // Use HarfBuzz's x_offset (already in vg.g.x) for fine adjustments.
            float gx = penX + vg.g.x - vg.g.fontPx * 0.5f;
            float gy = penY + vg.g.fontPx;        // baseline-ish for vertical
            vg.g.x = gx;
            vg.g.y = gy;
            utf8 += vg.g.sourceUtf8;
            currentPage.glyphs.push_back(vg.g);
            penY += vg.g.advance;
        }
        PageGlyphs::TextSpan sp;
        sp.utf8 = std::move(utf8);
        sp.x = penX - colWidth * 0.5f;
        sp.y = colTop;
        sp.w = colWidth;
        sp.h = penY - colTop;
        currentPage.textSpans.push_back(std::move(sp));
    }

    void layoutBlock(const Block& b) {
        std::vector<VGlyph> all;
        std::vector<bool>   isHardBreak;
        for (const auto& r : b.runs) {
            if (r.kind == InlineKind::LineBreak) {
                VGlyph vg{};
                vg.g.advance = 0.0f;
                vg.g.fontSlot = FontSlot::Regular;
                vg.g.fontPx = (float)opts.fontSize;
                vg.isWhitespace = true;
                vg.breakAfter = true;
                all.push_back(vg);
                isHardBreak.push_back(true);
                continue;
            }
            FontSlot slot = slotForRun(b, r);
            double px = slotPx(opts, b, slot);
            shapeRunVertical(r.text, faceFor(slot), slot, px, all);
            isHardBreak.resize(all.size(), false);
        }
        if (all.empty()) return;

        if (b.kind == BlockKind::Heading) {
            std::string flat;
            for (auto& r : b.runs) flat += r.text;
            HeadingAnchor a{};
            a.title = flat;
            a.level = b.level;
            a.pageIndex0 = pageIdx0;
            a.yOnPage = penX;        // for vertical: store column x as anchor
            result.headings.push_back(std::move(a));
        }

        const float maxColH = (float)(geo.height - geo.marginBottom);

        size_t i = 0;
        while (i < all.size()) {
            // Greedy fill of one column.
            size_t colStart = i;
            float  colY = penY;
            int    lastBreak = -1;        // index in `all` where we may break

            while (i < all.size()) {
                if (isHardBreak[i]) {
                    // Emit accumulated column up to (i-1) if any, then new column.
                    if (i > colStart) emitColumnSlice(all, colStart, i - 1);
                    newColumn();
                    ++i;
                    colStart = i;
                    colY = penY;
                    lastBreak = -1;
                    continue;
                }
                float adv = all[i].g.advance;
                if (colY + adv > maxColH) {
                    if (lastBreak < 0) {
                        // single glyph too tall: emit alone
                        emitColumnSlice(all, colStart, i);
                        newColumn();
                        colStart = i + 1;
                        colY = penY;
                        ++i;
                        lastBreak = -1;
                    } else {
                        emitColumnSlice(all, colStart, (size_t)lastBreak);
                        newColumn();
                        i = (size_t)lastBreak + 1;
                        colStart = i;
                        colY = penY;
                        lastBreak = -1;
                    }
                    continue;
                }
                colY += adv;
                if (all[i].breakAfter) lastBreak = (int)i;
                ++i;
            }
            // Flush the last partial column.
            if (i > colStart) {
                emitColumnSlice(all, colStart, i - 1);
                newColumn();
            }
        }

        // Paragraph spacing: a small gap to the next column.
        if (penY > (float)geo.marginTop) newColumn();
    }
};

VerticalLayout::VerticalLayout(const Options& opts, FontFace* r, FontFace* b,
                               FontFace* m, Logger* log)
    : impl_(std::make_unique<Impl>(opts, r, b, m, log)) {}

VerticalLayout::~VerticalLayout() = default;

LayoutResult VerticalLayout::run(const Document& doc) {
    for (const auto& b : doc.blocks) {
        if (b.kind == BlockKind::PageBreak) {
            impl_->newPage();
            continue;
        }
        if (b.kind == BlockKind::ThematicBreak) {
            impl_->newColumn();
            continue;
        }
        impl_->layoutBlock(b);
    }
    if (!impl_->currentPage.glyphs.empty() || !impl_->result.pages.empty()) {
        impl_->result.pages.push_back(std::move(impl_->currentPage));
    }
    return std::move(impl_->result);
}

}  // namespace inkling

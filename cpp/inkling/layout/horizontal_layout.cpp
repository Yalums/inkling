#include "horizontal_layout.h"

#include <algorithm>
#include <cstring>

#include <hb.h>

#include "../render/font_face.h"
#include "geometry.h"

namespace inkling {

namespace {

bool isCjk(uint32_t cp) {
    if (cp >= 0x3000 && cp <= 0x303F) return true;
    if (cp >= 0x3040 && cp <= 0x30FF) return true;
    if (cp >= 0x3400 && cp <= 0x4DBF) return true;
    if (cp >= 0x4E00 && cp <= 0x9FFF) return true;
    if (cp >= 0xF900 && cp <= 0xFAFF) return true;
    if (cp >= 0xFF00 && cp <= 0xFFEF) return true;
    if (cp >= 0x20000 && cp <= 0x2FFFF) return true;
    return false;
}

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

struct GlyphMeta {
    PlacedGlyph g;
    bool isWhitespace = false;   // glyph represents a space-like cluster
    bool breakAfter   = false;   // line may break after this glyph
};

void shapeRunInto(const std::string& text, FontFace* face, FontSlot slot,
                  double px, std::vector<GlyphMeta>& out) {
    if (!face || !face->isOpen() || text.empty()) return;

    hb_buffer_t* buf = hb_buffer_create();
    hb_buffer_add_utf8(buf, text.c_str(), (int)text.size(), 0, (int)text.size());
    hb_buffer_set_direction(buf, HB_DIRECTION_LTR);
    hb_buffer_guess_segment_properties(buf);

    hb_font_t* hbf = (hb_font_t*)face->harfbuzzFont(px);
    hb_shape(hbf, buf, nullptr, 0);

    unsigned int n = 0;
    hb_glyph_info_t* info = hb_buffer_get_glyph_infos(buf, &n);
    hb_glyph_position_t* pos = hb_buffer_get_glyph_positions(buf, &n);

    for (unsigned i = 0; i < n; ++i) {
        GlyphMeta gm{};
        gm.g.glyphIndex = info[i].codepoint;
        gm.g.x = 0;
        gm.g.y = pos[i].y_offset / 64.0f;
        gm.g.advance = pos[i].x_advance / 64.0f;
        gm.g.fontSlot = slot;
        gm.g.fontPx = (float)px;

        int byteStart = (int)info[i].cluster;
        int byteEnd   = (i + 1 < n) ? (int)info[i + 1].cluster : (int)text.size();
        if (byteStart >= 0 && byteEnd >= byteStart && byteEnd <= (int)text.size()) {
            gm.g.sourceUtf8 = text.substr(byteStart, byteEnd - byteStart);
        }

        uint32_t cp = utf8At(text, byteStart);
        gm.isWhitespace = (cp == ' ' || cp == '\t' || cp == 0x00A0);
        gm.breakAfter   = gm.isWhitespace || isCjk(cp);

        out.push_back(gm);
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

struct HorizontalLayout::Impl {
    Options       opts;
    PageGeometry  geo;
    FontFace*     regular;
    FontFace*     bold;
    FontFace*     mono;
    Logger*       log;

    LayoutResult  result;
    PageGlyphs    currentPage;
    float         penY;
    int           pageIdx0;

    Impl(const Options& o, FontFace* r, FontFace* b, FontFace* m, Logger* l)
        : opts(o), geo(geometryFromOptions(o)), regular(r), bold(b), mono(m), log(l),
          penY((float)o.marginTop), pageIdx0(0) {
        currentPage.pageNumber = 1;
    }

    FontFace* faceFor(FontSlot s) {
        switch (s) {
            case FontSlot::Bold: return bold ? bold : regular;
            case FontSlot::Mono: return mono ? mono : regular;
            default:             return regular;
        }
    }

    double maxAscender(const std::vector<GlyphMeta>& line) {
        double a = 0;
        for (auto& gm : line) {
            FontFace* f = faceFor(gm.g.fontSlot);
            if (f) a = std::max(a, f->ascender(gm.g.fontPx));
        }
        return a;
    }
    double maxLineHeight(const std::vector<GlyphMeta>& line) {
        double h = 0;
        for (auto& gm : line) {
            FontFace* f = faceFor(gm.g.fontSlot);
            if (f) h = std::max(h, f->lineHeight(gm.g.fontPx));
        }
        return h * opts.lineHeightMul;
    }

    void newPage() {
        result.pages.push_back(std::move(currentPage));
        ++pageIdx0;
        currentPage = PageGlyphs{};
        currentPage.pageNumber = pageIdx0 + 1;
        penY = (float)opts.marginTop;
    }

    // Place glyphs in `line` onto the current page starting at xStart.
    // line[].g.x is overwritten with the page-relative x.
    void emitLine(std::vector<GlyphMeta>& line, float xStart) {
        if (line.empty()) return;
        double asc = maxAscender(line);
        double lineH = maxLineHeight(line);

        if (penY + lineH > geo.height - geo.marginBottom) {
            newPage();
        }
        float baseline = penY + (float)asc;

        float x = xStart;
        std::string lineUtf8;
        lineUtf8.reserve(line.size() * 2);
        for (auto& gm : line) {
            gm.g.x = x;
            gm.g.y = baseline + gm.g.y;
            lineUtf8 += gm.g.sourceUtf8;
            currentPage.glyphs.push_back(gm.g);
            x += gm.g.advance;
        }

        PageGlyphs::TextSpan sp;
        sp.utf8 = std::move(lineUtf8);
        sp.x = xStart;
        sp.y = baseline - (float)asc;
        sp.w = x - xStart;
        sp.h = (float)lineH;
        currentPage.textSpans.push_back(std::move(sp));

        penY += (float)lineH;
        line.clear();
    }

    void layoutBlock(const Block& b) {
        std::vector<GlyphMeta> all;
        std::vector<bool> isHardBreak;  // parallel to `all`
        for (auto& r : b.runs) {
            if (r.kind == InlineKind::LineBreak) {
                GlyphMeta gm{};
                gm.g.advance = 0.0f;
                gm.g.fontSlot = FontSlot::Regular;
                gm.g.fontPx = (float)opts.fontSize;
                gm.isWhitespace = true;
                gm.breakAfter   = true;
                all.push_back(gm);
                isHardBreak.push_back(true);
                continue;
            }
            FontSlot slot = slotForRun(b, r);
            double px = slotPx(opts, b, slot);
            size_t before = all.size();
            shapeRunInto(r.text, faceFor(slot), slot, px, all);
            isHardBreak.resize(all.size(), false);
            (void)before;
        }
        if (all.empty()) return;

        float xStart = (float)opts.marginLeft;
        if (b.kind == BlockKind::OrderedItem || b.kind == BlockKind::UnorderedItem) {
            xStart += (float)b.listDepth * 32.0f + 24.0f;
        }
        const float maxW = (float)geo.contentWidth() - (xStart - opts.marginLeft);

        if (b.kind == BlockKind::Heading) {
            std::string flat;
            for (auto& r : b.runs) flat += r.text;
            HeadingAnchor a{};
            a.title = flat;
            a.level = b.level;
            a.pageIndex0 = pageIdx0;
            a.yOnPage = penY;
            result.headings.push_back(std::move(a));
        }

        // Greedy line builder.
        std::vector<GlyphMeta> line;
        line.reserve(all.size());
        float lineW = 0.0f;
        int   lastBreak = -1;       // index in `line` after which we may break

        auto flush = [&](int upToIncl) {
            // Emit line[0..upToIncl] (inclusive), keep tail.
            std::vector<GlyphMeta> head(line.begin(), line.begin() + upToIncl + 1);
            // Trim trailing whitespace from head.
            while (!head.empty() && head.back().isWhitespace) head.pop_back();
            emitLine(head, xStart);
            std::vector<GlyphMeta> tail(line.begin() + upToIncl + 1, line.end());
            // Strip leading whitespace from tail.
            while (!tail.empty() && tail.front().isWhitespace) tail.erase(tail.begin());
            line = std::move(tail);
            lineW = 0.0f;
            for (auto& gm : line) lineW += gm.g.advance;
            lastBreak = -1;
            for (int i = (int)line.size() - 1; i >= 0; --i) {
                if (line[i].breakAfter) { lastBreak = i; break; }
            }
        };

        for (size_t i = 0; i < all.size(); ++i) {
            if (isHardBreak[i]) {
                emitLine(line, xStart);
                lineW = 0.0f;
                lastBreak = -1;
                continue;
            }
            line.push_back(all[i]);
            lineW += all[i].g.advance;
            if (all[i].breakAfter) lastBreak = (int)line.size() - 1;
            while (lineW > maxW && lastBreak >= 0 && lastBreak < (int)line.size() - 1) {
                flush(lastBreak);
            }
            if (lineW > maxW && lastBreak < 0 && line.size() == 1) {
                std::vector<GlyphMeta> tmp = std::move(line);
                emitLine(tmp, xStart);
                line.clear();
                lineW = 0.0f;
            }
        }
        if (!line.empty()) emitLine(line, xStart);

        penY += (float)opts.paragraphSpacing;
    }
};

HorizontalLayout::HorizontalLayout(const Options& opts, FontFace* r, FontFace* b,
                                   FontFace* m, Logger* log)
    : impl_(std::make_unique<Impl>(opts, r, b, m, log)) {}

HorizontalLayout::~HorizontalLayout() = default;

LayoutResult HorizontalLayout::run(const Document& doc) {
    for (const auto& b : doc.blocks) {
        if (b.kind == BlockKind::PageBreak) {
            impl_->newPage();
            continue;
        }
        if (b.kind == BlockKind::ThematicBreak) {
            impl_->penY += (float)(impl_->opts.fontSize * 1.5);
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

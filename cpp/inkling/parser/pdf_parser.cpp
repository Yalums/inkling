#include "pdf_parser.h"

extern "C" {
#include <mupdf/fitz.h>
}

#include <string>

namespace inkling {

namespace {

void appendUtf8(std::string& s, uint32_t cp) {
    if (cp < 0x80) {
        s.push_back((char)cp);
    } else if (cp < 0x800) {
        s.push_back((char)(0xC0 | (cp >> 6)));
        s.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        s.push_back((char)(0xE0 | (cp >> 12)));
        s.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        s.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
        s.push_back((char)(0xF0 | (cp >> 18)));
        s.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
        s.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        s.push_back((char)(0x80 | (cp & 0x3F)));
    }
}

// Drain one fz_stext_block (text type only) into a Block of paragraphs/lines.
void drainBlock(fz_context* ctx, fz_stext_block* tb, Document* out) {
    if (tb->type != FZ_STEXT_BLOCK_TEXT) return;

    // Each text block becomes a Paragraph; each line within becomes a soft
    // line break inside that paragraph (text-flow gives us paragraphs).
    Block b;
    b.kind = BlockKind::Paragraph;
    bool first = true;
    for (fz_stext_line* line = tb->u.t.first_line; line; line = line->next) {
        std::string lineText;
        for (fz_stext_char* ch = line->first_char; ch; ch = ch->next) {
            if (ch->c == 0xFFFD) continue;
            appendUtf8(lineText, (uint32_t)ch->c);
        }
        if (lineText.empty()) continue;
        if (!first) {
            b.runs.push_back(InlineRun{InlineKind::LineBreak, "", 0});
        }
        b.runs.push_back(InlineRun{InlineKind::Text, std::move(lineText), 0});
        first = false;
    }
    if (!b.runs.empty()) out->blocks.push_back(std::move(b));
    (void)ctx;
}

void readMetadata(fz_context* ctx, fz_document* doc, Document* out) {
    char buf[1024];
    int n = fz_lookup_metadata(ctx, doc, FZ_META_INFO_TITLE, buf, sizeof(buf));
    if (n > 0 && out->title.empty())  out->title.assign(buf, (size_t)(n - 1));
    n = fz_lookup_metadata(ctx, doc, FZ_META_INFO_AUTHOR, buf, sizeof(buf));
    if (n > 0 && out->author.empty()) out->author.assign(buf, (size_t)(n - 1));
}

}  // namespace

bool parsePdf(const std::filesystem::path& path, Document* out, Logger* log) {
    if (!out) return false;

    fz_context* ctx = fz_new_context(nullptr, nullptr, FZ_STORE_DEFAULT);
    if (!ctx) {
        if (log) log->log(LogLevel::Error, "pdfin", "fz_new_context failed");
        return false;
    }
    fz_register_document_handlers(ctx);

    fz_document* doc = nullptr;
    bool ok = false;

    fz_try(ctx) {
        doc = fz_open_document(ctx, path.string().c_str());
        if (!doc) fz_throw(ctx, FZ_ERROR_GENERIC, "open_document returned NULL");
        readMetadata(ctx, doc, out);

        int npages = fz_count_pages(ctx, doc);
        for (int i = 0; i < npages; ++i) {
            fz_page* page = fz_load_page(ctx, doc, i);
            fz_stext_options opts{};
            fz_stext_page* stext = fz_new_stext_page_from_page(ctx, page, &opts);

            for (fz_stext_block* block = stext->first_block; block; block = block->next) {
                drainBlock(ctx, block, out);
            }

            // Page break between source pages so the new layout's
            // bookmark/page numbering reflects the original.
            if (i + 1 < npages) {
                Block pb;
                pb.kind = BlockKind::PageBreak;
                out->blocks.push_back(std::move(pb));
            }

            fz_drop_stext_page(ctx, stext);
            fz_drop_page(ctx, page);
        }
        ok = true;
    } fz_catch(ctx) {
        if (log) log->log(LogLevel::Error, "pdfin", fz_caught_message(ctx));
        ok = false;
    }

    if (doc) fz_drop_document(ctx, doc);
    fz_drop_context(ctx);
    return ok;
}

}  // namespace inkling

#include "pipeline.h"

#include <algorithm>
#include <cctype>

#include "document.h"
#include "encode/jpeg.h"
#include "layout/horizontal_layout.h"
#include "parser/md_parser.h"
#include "parser/txt_parser.h"
#include "pdf/pdf_builder.h"
#include "render/font_face.h"
#include "render/page_raster.h"

#if INKLING_HAS_VERTICAL_LAYOUT
#include "layout/vertical_layout.h"
#endif
#if INKLING_HAS_EPUB
#include "parser/epub_parser.h"
#endif
#if INKLING_HAS_DOCX
#include "parser/docx_parser.h"
#endif
#if INKLING_HAS_PDFIN
#include "parser/pdf_parser.h"
#endif
#if INKLING_HAS_PARALLEL
#include "util/thread_pool.h"
#endif

namespace inkling {

namespace {

std::string lowerExt(const std::filesystem::path& p) {
    std::string e = p.extension().string();
    for (char& c : e) c = (char)std::tolower((unsigned char)c);
    return e;
}

void emit(ink_progress_cb cb, void* ud, const char* job, ink_stage_t s, int pct) {
    if (cb) cb(job, (int)s, pct, ud);
}

bool parseInput(const std::filesystem::path& in, Document* doc, Logger* log) {
    std::string ext = lowerExt(in);
    if (ext == ".txt") return parseTxt(in, doc);
    if (ext == ".md" || ext == ".markdown") return parseMarkdown(in, doc);
#if INKLING_HAS_EPUB
    if (ext == ".epub") return parseEpub(in, doc, log);
#endif
#if INKLING_HAS_DOCX
    if (ext == ".docx") return parseDocx(in, doc, log);
#endif
#if INKLING_HAS_PDFIN
    if (ext == ".pdf")  return parsePdf(in, doc, log);
#endif
    if (log) log->log(LogLevel::Error, "pipeline", "unsupported input extension");
    return false;
}

}  // namespace

ink_status_t runPipeline(const std::filesystem::path& input,
                         const std::filesystem::path& output,
                         const Options& opts,
                         const char* jobId,
                         ink_progress_cb progressCb,
                         void* progressUserdata,
                         Logger* log) {
    NullLogger nullLog;
    if (!log) log = &nullLog;

    if (opts.fontPath.empty()) {
        log->log(LogLevel::Error, "pipeline", "options.fontPath is required");
        return INK_ERR_INVALID_OPTIONS;
    }

    // ── Parse ─────────────────────────────────────────────────────────────
    emit(progressCb, progressUserdata, jobId, INK_STAGE_PARSE, 0);
    Document doc;
    if (!parseInput(input, &doc, log)) {
        log->log(LogLevel::Error, "pipeline", "parse failed");
        return INK_ERR_PARSE;
    }
    if (doc.blocks.empty()) {
        log->log(LogLevel::Warn, "pipeline", "document has no blocks");
    }
    emit(progressCb, progressUserdata, jobId, INK_STAGE_PARSE, 100);

    // ── Fonts ────────────────────────────────────────────────────────────
    FontFace regular, bold, mono;
    if (!regular.open(opts.fontPath)) {
        log->log(LogLevel::Error, "pipeline", "failed to open regular font");
        return INK_ERR_RENDER;
    }
    if (!opts.fontPathBold.empty()) bold.open(opts.fontPathBold);
    if (!opts.fontPathMono.empty()) mono.open(opts.fontPathMono);

    // ── Layout ───────────────────────────────────────────────────────────
    emit(progressCb, progressUserdata, jobId, INK_STAGE_LAYOUT, 0);
    LayoutResult layout;
    if (opts.orientation == Orientation::VerticalRtl) {
#if INKLING_HAS_VERTICAL_LAYOUT
        VerticalLayout vl(opts, &regular,
                          bold.isOpen() ? &bold : nullptr,
                          mono.isOpen() ? &mono : nullptr,
                          log);
        layout = vl.run(doc);
#else
        HorizontalLayout hl(opts, &regular,
                            bold.isOpen() ? &bold : nullptr,
                            mono.isOpen() ? &mono : nullptr,
                            log);
        layout = hl.run(doc);
#endif
    } else {
        HorizontalLayout hl(opts, &regular,
                            bold.isOpen() ? &bold : nullptr,
                            mono.isOpen() ? &mono : nullptr,
                            log);
        layout = hl.run(doc);
    }
    emit(progressCb, progressUserdata, jobId, INK_STAGE_LAYOUT, 100);
    if (layout.pages.empty()) {
        log->log(LogLevel::Warn, "pipeline", "layout produced no pages");
    }

    // ── Render + Encode + PDF ────────────────────────────────────────────
    emit(progressCb, progressUserdata, jobId, INK_STAGE_RENDER, 0);
    PageRaster raster(opts, &regular,
                      bold.isOpen() ? &bold : nullptr,
                      mono.isOpen() ? &mono : nullptr, log);

    PdfBuilder pdf(opts.pageWidth, opts.pageHeight, log);
    pdf.setMetadata(doc.title, doc.author);

    const int pageCount = (int)layout.pages.size();

#if INKLING_HAS_PARALLEL
    // Parallel render → JPEG; then sequential PDF assembly preserves order.
    int threads = opts.threadCount > 0
                  ? opts.threadCount
                  : std::max(1, (int)std::thread::hardware_concurrency());
    threads = std::min(threads, std::max(1, pageCount));
    std::vector<std::vector<uint8_t>> jpegByPage(pageCount);
    {
        ThreadPool pool(threads);
        std::vector<std::future<void>> futs;
        for (int i = 0; i < pageCount; ++i) {
            futs.push_back(pool.submit([&, i] {
                Bitmap8 bm;
                if (!raster.render(layout.pages[i], &bm)) return;
                std::vector<uint8_t> jpeg;
                if (!encodeJpegGray(bm, opts.jpegQuality, &jpeg)) return;
                jpegByPage[i] = std::move(jpeg);
            }));
        }
        for (auto& f : futs) f.get();
    }
    for (int i = 0; i < pageCount; ++i) {
        if (jpegByPage[i].empty()) continue;
        pdf.addJpegPage(jpegByPage[i]);
        if (opts.embedTextLayer) {
            for (const auto& sp : layout.pages[i].textSpans) {
                if (!sp.utf8.empty()) {
                    pdf.addInvisibleText(sp.utf8, sp.x, sp.y, sp.w, sp.h);
                }
            }
        }
        emit(progressCb, progressUserdata, jobId, INK_STAGE_RENDER,
             100 * (i + 1) / std::max(1, pageCount));
    }
#else
    for (int i = 0; i < pageCount; ++i) {
        Bitmap8 bm;
        if (!raster.render(layout.pages[i], &bm)) {
            log->log(LogLevel::Error, "pipeline", "raster failed");
            return INK_ERR_RENDER;
        }
        std::vector<uint8_t> jpeg;
        if (!encodeJpegGray(bm, opts.jpegQuality, &jpeg)) {
            log->log(LogLevel::Error, "pipeline", "jpeg encode failed");
            return INK_ERR_ENCODE;
        }
        pdf.addJpegPage(jpeg);
        if (opts.embedTextLayer) {
            for (const auto& sp : layout.pages[i].textSpans) {
                if (!sp.utf8.empty()) {
                    pdf.addInvisibleText(sp.utf8, sp.x, sp.y, sp.w, sp.h);
                }
            }
        }
        emit(progressCb, progressUserdata, jobId, INK_STAGE_RENDER,
             100 * (i + 1) / std::max(1, pageCount));
    }
#endif

    if (opts.embedBookmarks) {
        for (const auto& a : layout.headings) {
            pdf.addOutline(a.title, a.level, a.pageIndex0);
        }
    }

    emit(progressCb, progressUserdata, jobId, INK_STAGE_PACKAGE, 50);
    if (!pdf.save(output)) {
        log->log(LogLevel::Error, "pipeline", "pdf save failed");
        return INK_ERR_WRITE_OUTPUT;
    }
    emit(progressCb, progressUserdata, jobId, INK_STAGE_PACKAGE, 100);
    emit(progressCb, progressUserdata, jobId, INK_STAGE_DONE, 100);
    return INK_OK;
}

}  // namespace inkling

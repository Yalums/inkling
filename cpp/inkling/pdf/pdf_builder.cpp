#include "pdf_builder.h"

#include <hpdf.h>
#include <hpdf_consts.h>

#include <cstring>

namespace inkling {

namespace {

void onError(HPDF_STATUS error_no, HPDF_STATUS detail_no, void* user_data) {
    auto* log = (Logger*)user_data;
    if (!log) return;
    char msg[128];
    std::snprintf(msg, sizeof(msg), "libharu: error=%04x detail=%u",
                  (unsigned)error_no, (unsigned)detail_no);
    log->log(LogLevel::Error, "pdf", msg);
}

}  // namespace

struct PdfBuilder::Impl {
    HPDF_Doc           doc = nullptr;
    int                pageWidthPx = 0;
    int                pageHeightPx = 0;
    Logger*            log = nullptr;
    int                pageCount = 0;
    HPDF_Page          lastPage = nullptr;
    HPDF_Font          textFont = nullptr;
    std::string        textEncoding = "StandardEncoding";
    std::vector<HPDF_Page> pages;
    std::vector<HPDF_Outline> outlinesByLevel;
};

PdfBuilder::PdfBuilder(int pw, int ph, Logger* log) : impl_(std::make_unique<Impl>()) {
    impl_->pageWidthPx = pw;
    impl_->pageHeightPx = ph;
    impl_->log = log;
    impl_->doc = HPDF_New(&onError, log);
    if (impl_->doc) {
        HPDF_SetCompressionMode(impl_->doc, HPDF_COMP_ALL);
        impl_->textFont = HPDF_GetFont(impl_->doc, "Helvetica", nullptr);
    }
}

PdfBuilder::~PdfBuilder() {
    if (impl_->doc) HPDF_Free(impl_->doc);
}

bool PdfBuilder::setMetadata(const std::string& title, const std::string& author) {
    if (!impl_->doc) return false;
    if (!title.empty())  HPDF_SetInfoAttr(impl_->doc, HPDF_INFO_TITLE,  title.c_str());
    if (!author.empty()) HPDF_SetInfoAttr(impl_->doc, HPDF_INFO_AUTHOR, author.c_str());
    HPDF_SetInfoAttr(impl_->doc, HPDF_INFO_CREATOR, "Inkling");
    return true;
}

bool PdfBuilder::setTextFont(const std::string& path) {
    if (!impl_->doc || path.empty()) return false;
    HPDF_UseUTFEncodings(impl_->doc);
    HPDF_SetCurrentEncoder(impl_->doc, "UTF-8");
    const char* fontName = HPDF_LoadTTFontFromFile(impl_->doc, path.c_str(), HPDF_TRUE);
    if (!fontName) {
        if (impl_->log) impl_->log->log(LogLevel::Warn, "pdf",
            "setTextFont: HPDF_LoadTTFontFromFile failed; falling back to Helvetica");
        return false;
    }
    HPDF_Font f = HPDF_GetFont(impl_->doc, fontName, "UTF-8");
    if (!f) return false;
    impl_->textFont = f;
    impl_->textEncoding = "UTF-8";
    return true;
}

int PdfBuilder::addJpegPage(const std::vector<uint8_t>& jpeg) {
    if (!impl_->doc || jpeg.empty()) return -1;

    HPDF_Page page = HPDF_AddPage(impl_->doc);
    if (!page) return -1;

    // Use raster pixels as user units 1:1 to keep the text layer math simple.
    HPDF_Page_SetWidth(page,  (HPDF_REAL)impl_->pageWidthPx);
    HPDF_Page_SetHeight(page, (HPDF_REAL)impl_->pageHeightPx);

    HPDF_Image img = HPDF_LoadJpegImageFromMem(impl_->doc,
                                               (const HPDF_BYTE*)jpeg.data(),
                                               (HPDF_UINT)jpeg.size());
    if (!img) return -1;

    HPDF_Page_DrawImage(page, img,
                        0, 0,
                        (HPDF_REAL)impl_->pageWidthPx,
                        (HPDF_REAL)impl_->pageHeightPx);

    impl_->lastPage = page;
    impl_->pages.push_back(page);
    return impl_->pageCount++;
}

bool PdfBuilder::addInvisibleText(const std::string& utf8,
                                  float xPx, float yPx, float wPx, float hPx) {
    if (!impl_->lastPage || utf8.empty()) return false;

    HPDF_Page page = impl_->lastPage;
    HPDF_Page_BeginText(page);
    HPDF_Page_SetTextRenderingMode(page, HPDF_INVISIBLE);
    HPDF_Page_SetFontAndSize(page, impl_->textFont, hPx > 0 ? hPx * 0.7f : 12.0f);

    // Convert top-left raster coords → PDF bottom-left.
    float pdfX = xPx;
    float pdfY = (float)impl_->pageHeightPx - (yPx + hPx);

    HPDF_Page_TextOut(page, pdfX, pdfY, utf8.c_str());
    HPDF_Page_EndText(page);
    return true;
}

bool PdfBuilder::addOutline(const std::string& title, int level, int pageIndex0) {
    if (!impl_->doc) return false;
    if (pageIndex0 < 0 || pageIndex0 >= (int)impl_->pages.size()) return false;
    if (level < 1) level = 1;

    HPDF_Outline parent = nullptr;
    if (level > 1 && (int)impl_->outlinesByLevel.size() >= level - 1) {
        parent = impl_->outlinesByLevel[level - 2];
    }
    HPDF_Outline outline = HPDF_CreateOutline(impl_->doc, parent, title.c_str(), nullptr);
    if (!outline) return false;
    HPDF_Destination dst = HPDF_Page_CreateDestination(impl_->pages[pageIndex0]);
    if (dst) {
        HPDF_Destination_SetXYZ(dst, 0, (HPDF_REAL)impl_->pageHeightPx, 1);
        HPDF_Outline_SetDestination(outline, dst);
    }
    impl_->outlinesByLevel.resize(level);
    impl_->outlinesByLevel[level - 1] = outline;
    return true;
}

bool PdfBuilder::save(const std::filesystem::path& path) {
    if (!impl_->doc) return false;
    HPDF_STATUS rc = HPDF_SaveToFile(impl_->doc, path.string().c_str());
    return rc == HPDF_OK;
}

}  // namespace inkling

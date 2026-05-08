#ifndef INKLING_PDF_PDF_BUILDER_H_
#define INKLING_PDF_PDF_BUILDER_H_

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include "../layout/line_box.h"
#include "../logger.h"

namespace inkling {

class PdfBuilder {
public:
    PdfBuilder(int pageWidthPx, int pageHeightPx, Logger* log);
    ~PdfBuilder();
    PdfBuilder(const PdfBuilder&) = delete;
    PdfBuilder& operator=(const PdfBuilder&) = delete;

    bool setMetadata(const std::string& title, const std::string& author);

    // Add one page rendered from a JPEG byte buffer. Returns the libharu page
    // index (0-based) on success, -1 on failure.
    int addJpegPage(const std::vector<uint8_t>& jpeg);

    // Place an invisible text annotation on the most recently added page.
    // Coordinates are in raster pixels (top-left origin); converted to PDF
    // user space (bottom-left origin) internally.
    bool addInvisibleText(const std::string& utf8,
                          float xPx, float yPx, float widthPx, float heightPx);

    // Add a top-level outline (bookmark). For nested levels, addOutlineChild
    // adds under the most recent same-level parent.
    bool addOutline(const std::string& title, int level, int pageIndex0);

    bool save(const std::filesystem::path& path);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace inkling

#endif

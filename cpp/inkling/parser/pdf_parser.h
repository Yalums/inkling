#ifndef INKLING_PARSER_PDF_PARSER_H_
#define INKLING_PARSER_PDF_PARSER_H_

#include <filesystem>

#include "../document.h"
#include "../logger.h"

namespace inkling {

// Re-flow input PDF into Inkling Document blocks. Requires the source PDF
// to have a text layer (born-digital or OCR'd). Image-only PDFs would need
// OCR — out of scope for M7.
bool parsePdf(const std::filesystem::path& path, Document* out, Logger* log);

}  // namespace inkling

#endif

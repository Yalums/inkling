#ifndef INKLING_PARSER_EPUB_PARSER_H_
#define INKLING_PARSER_EPUB_PARSER_H_

#include <filesystem>

#include "../document.h"
#include "../logger.h"

namespace inkling {

bool parseEpub(const std::filesystem::path& path, Document* out, Logger* log);

}  // namespace inkling

#endif

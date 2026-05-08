#ifndef INKLING_PARSER_DOCX_PARSER_H_
#define INKLING_PARSER_DOCX_PARSER_H_

#include <filesystem>

#include "../document.h"
#include "../logger.h"

namespace inkling {

bool parseDocx(const std::filesystem::path& path, Document* out, Logger* log);

}  // namespace inkling

#endif

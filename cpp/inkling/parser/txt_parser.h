#ifndef INKLING_PARSER_TXT_PARSER_H_
#define INKLING_PARSER_TXT_PARSER_H_

#include "../document.h"

#include <filesystem>

namespace inkling {

bool parseTxt(const std::filesystem::path& path, Document* out);
bool parseTxtFromString(const std::string& src, Document* out);

}  // namespace inkling

#endif

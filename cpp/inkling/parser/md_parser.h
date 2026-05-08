#ifndef INKLING_PARSER_MD_PARSER_H_
#define INKLING_PARSER_MD_PARSER_H_

#include "../document.h"

#include <filesystem>

namespace inkling {

// Minimal CommonMark subset: ATX headings, fenced code blocks, thematic
// breaks, ordered/unordered lists, paragraphs, inline emphasis/strong/code.
// Unsupported: links, images, tables, blockquotes, setext headings,
// reference definitions, HTML pass-through.
bool parseMarkdown(const std::filesystem::path& path, Document* out);
bool parseMarkdownFromString(const std::string& src, Document* out);

}  // namespace inkling

#endif

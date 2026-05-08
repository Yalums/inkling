#include "txt_parser.h"

#include <fstream>
#include <sstream>

namespace inkling {

namespace {

bool isBlank(const std::string& s) {
    for (char c : s) {
        if (c != ' ' && c != '\t' && c != '\r') return false;
    }
    return true;
}

void stripBom(std::string& s) {
    if (s.size() >= 3 && (uint8_t)s[0] == 0xEF && (uint8_t)s[1] == 0xBB && (uint8_t)s[2] == 0xBF) {
        s.erase(0, 3);
    }
}

void appendParagraph(Document* doc, std::string text) {
    while (!text.empty() && (text.back() == '\r' || text.back() == ' ')) text.pop_back();
    if (text.empty()) return;
    Block b;
    b.kind = BlockKind::Paragraph;
    b.runs.push_back(InlineRun{InlineKind::Text, std::move(text), 0});
    doc->blocks.push_back(std::move(b));
}

}  // namespace

bool parseTxtFromString(const std::string& srcIn, Document* out) {
    if (!out) return false;
    std::string src = srcIn;
    stripBom(src);

    std::stringstream ss(src);
    std::string line;
    std::string buf;
    while (std::getline(ss, line)) {
        if (isBlank(line)) {
            appendParagraph(out, std::move(buf));
            buf.clear();
        } else {
            if (!buf.empty()) buf.push_back(' ');
            // strip trailing \r
            while (!line.empty() && line.back() == '\r') line.pop_back();
            buf.append(line);
        }
    }
    appendParagraph(out, std::move(buf));
    return true;
}

bool parseTxt(const std::filesystem::path& path, Document* out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::stringstream buf;
    buf << f.rdbuf();
    return parseTxtFromString(buf.str(), out);
}

}  // namespace inkling

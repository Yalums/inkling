#include "md_parser.h"

#include <cctype>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>

namespace inkling {

namespace {

void stripBom(std::string& s) {
    if (s.size() >= 3 && (uint8_t)s[0] == 0xEF && (uint8_t)s[1] == 0xBB && (uint8_t)s[2] == 0xBF) {
        s.erase(0, 3);
    }
}

bool startsWith(const std::string& s, const char* p) {
    size_t n = 0;
    while (p[n]) ++n;
    return s.size() >= n && std::memcmp(s.data(), p, n) == 0;
}

int countLeadingSpaces(const std::string& s) {
    int n = 0;
    while (n < (int)s.size() && (s[n] == ' ' || s[n] == '\t')) ++n;
    return n;
}

bool isThematicBreak(const std::string& line) {
    int hits = 0;
    char want = 0;
    for (char c : line) {
        if (c == ' ' || c == '\t') continue;
        if (want == 0 && (c == '*' || c == '-' || c == '_')) {
            want = c;
            ++hits;
        } else if (c == want) {
            ++hits;
        } else {
            return false;
        }
    }
    return hits >= 3;
}

int atxLevel(const std::string& line) {
    int n = 0;
    while (n < 6 && n < (int)line.size() && line[n] == '#') ++n;
    if (n == 0) return 0;
    if (n < (int)line.size() && line[n] != ' ') return 0;
    return n;
}

// Returns the inline runs of `text`. Recognises *em*, **strong**, `code`.
// Underscore variants ignored to keep parser simple.
std::vector<InlineRun> parseInlines(const std::string& text) {
    std::vector<InlineRun> runs;
    std::string buf;
    auto flushText = [&]() {
        if (!buf.empty()) {
            runs.push_back(InlineRun{InlineKind::Text, std::move(buf), 0});
            buf.clear();
        }
    };

    size_t i = 0, n = text.size();
    while (i < n) {
        char c = text[i];

        if (c == '\\' && i + 1 < n) {
            buf.push_back(text[i + 1]);
            i += 2;
            continue;
        }

        if (c == '`') {
            size_t j = text.find('`', i + 1);
            if (j != std::string::npos) {
                flushText();
                runs.push_back(InlineRun{InlineKind::Code, text.substr(i + 1, j - i - 1), (int32_t)i});
                i = j + 1;
                continue;
            }
        }

        if (c == '*' && i + 1 < n && text[i + 1] == '*') {
            size_t j = text.find("**", i + 2);
            if (j != std::string::npos) {
                flushText();
                runs.push_back(InlineRun{InlineKind::Strong, text.substr(i + 2, j - i - 2), (int32_t)i});
                i = j + 2;
                continue;
            }
        }

        if (c == '*') {
            size_t j = text.find('*', i + 1);
            if (j != std::string::npos) {
                flushText();
                runs.push_back(InlineRun{InlineKind::Emphasis, text.substr(i + 1, j - i - 1), (int32_t)i});
                i = j + 1;
                continue;
            }
        }

        buf.push_back(c);
        ++i;
    }
    flushText();
    return runs;
}

void emitParagraph(Document* doc, std::string& buf) {
    while (!buf.empty() && (buf.back() == ' ' || buf.back() == '\r' || buf.back() == '\n')) buf.pop_back();
    if (buf.empty()) return;
    Block b;
    b.kind = BlockKind::Paragraph;
    b.runs = parseInlines(buf);
    doc->blocks.push_back(std::move(b));
    buf.clear();
}

bool tryListMarker(const std::string& line, int* outOrdered, int* outContentStart) {
    int i = countLeadingSpaces(line);
    if (i >= (int)line.size()) return false;

    if (line[i] == '-' || line[i] == '*' || line[i] == '+') {
        if (i + 1 < (int)line.size() && line[i + 1] == ' ') {
            *outOrdered = -1;
            *outContentStart = i + 2;
            return true;
        }
    }
    int j = i;
    while (j < (int)line.size() && std::isdigit((unsigned char)line[j])) ++j;
    if (j > i && j < (int)line.size() && line[j] == '.' && j + 1 < (int)line.size() && line[j + 1] == ' ') {
        *outOrdered = std::atoi(line.c_str() + i);
        *outContentStart = j + 2;
        return true;
    }
    return false;
}

}  // namespace

bool parseMarkdownFromString(const std::string& srcIn, Document* out) {
    if (!out) return false;
    std::string src = srcIn;
    stripBom(src);

    std::stringstream ss(src);
    std::vector<std::string> lines;
    {
        std::string line;
        while (std::getline(ss, line)) {
            while (!line.empty() && line.back() == '\r') line.pop_back();
            lines.push_back(std::move(line));
        }
    }

    std::string paraBuf;
    bool inFence = false;
    std::string fenceMark;
    std::string fenceBuf;

    for (size_t li = 0; li < lines.size(); ++li) {
        const std::string& line = lines[li];

        if (inFence) {
            if (startsWith(line, fenceMark.c_str())) {
                Block b;
                b.kind = BlockKind::CodeBlock;
                b.runs.push_back(InlineRun{InlineKind::Text, fenceBuf, 0});
                out->blocks.push_back(std::move(b));
                fenceBuf.clear();
                inFence = false;
                fenceMark.clear();
            } else {
                fenceBuf.append(line);
                fenceBuf.push_back('\n');
            }
            continue;
        }

        if (startsWith(line, "```") || startsWith(line, "~~~")) {
            emitParagraph(out, paraBuf);
            inFence = true;
            fenceMark = line.substr(0, 3);
            continue;
        }

        if (line.empty()) {
            emitParagraph(out, paraBuf);
            continue;
        }

        if (isThematicBreak(line)) {
            emitParagraph(out, paraBuf);
            Block b;
            b.kind = BlockKind::ThematicBreak;
            out->blocks.push_back(std::move(b));
            continue;
        }

        int hLevel = atxLevel(line);
        if (hLevel > 0) {
            emitParagraph(out, paraBuf);
            std::string title = line.substr(hLevel + 1);
            while (!title.empty() && title.back() == '#') title.pop_back();
            while (!title.empty() && title.back() == ' ') title.pop_back();
            Block b;
            b.kind = BlockKind::Heading;
            b.level = hLevel;
            b.runs = parseInlines(title);
            out->blocks.push_back(std::move(b));
            if (out->title.empty() && hLevel == 1) {
                std::string flat;
                for (auto& r : b.runs) flat += r.text;
                out->title = flat;
            }
            continue;
        }

        int ord = 0, cs = 0;
        if (tryListMarker(line, &ord, &cs)) {
            emitParagraph(out, paraBuf);
            int depth = countLeadingSpaces(line) / 2;
            Block b;
            b.kind = (ord == -1) ? BlockKind::UnorderedItem : BlockKind::OrderedItem;
            b.level = (ord == -1) ? 0 : ord;
            b.listDepth = depth;
            b.runs = parseInlines(line.substr(cs));
            out->blocks.push_back(std::move(b));
            continue;
        }

        if (!paraBuf.empty()) paraBuf.push_back(' ');
        paraBuf.append(line);
    }

    emitParagraph(out, paraBuf);

    if (inFence) {
        Block b;
        b.kind = BlockKind::CodeBlock;
        b.runs.push_back(InlineRun{InlineKind::Text, std::move(fenceBuf), 0});
        out->blocks.push_back(std::move(b));
    }
    return true;
}

bool parseMarkdown(const std::filesystem::path& path, Document* out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::stringstream buf;
    buf << f.rdbuf();
    return parseMarkdownFromString(buf.str(), out);
}

}  // namespace inkling

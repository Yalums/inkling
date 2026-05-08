#include "docx_parser.h"

#include <pugixml.hpp>

#include <cstring>
#include <string>

#include "../util/zip_reader.h"

namespace inkling {

namespace {

const char* kWmlNs = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

bool localNameEq(const pugi::xml_node& n, const char* local) {
    const char* full = n.name();
    if (!full) return false;
    const char* colon = std::strchr(full, ':');
    const char* lp = colon ? colon + 1 : full;
    return std::strcmp(lp, local) == 0;
}

bool hasChildLocal(const pugi::xml_node& parent, const char* local) {
    for (auto c : parent.children()) {
        if (localNameEq(c, local)) return true;
    }
    return false;
}

pugi::xml_node firstChildLocal(const pugi::xml_node& parent, const char* local) {
    for (auto c : parent.children()) {
        if (localNameEq(c, local)) return c;
    }
    return pugi::xml_node();
}

int headingLevelFromStyle(const std::string& v) {
    if (v == "Title") return 1;
    static const char* prefix = "Heading";
    if (v.compare(0, std::strlen(prefix), prefix) == 0) {
        char c = v.size() > std::strlen(prefix) ? v[std::strlen(prefix)] : 0;
        if (c >= '1' && c <= '9') return c - '0';
    }
    return 0;
}

void appendRunInlines(const pugi::xml_node& wR, std::vector<InlineRun>& out) {
    auto rPr = firstChildLocal(wR, "rPr");
    bool bold   = rPr && hasChildLocal(rPr, "b");
    bool italic = rPr && hasChildLocal(rPr, "i");

    InlineKind kind = bold ? InlineKind::Strong
                           : (italic ? InlineKind::Emphasis : InlineKind::Text);

    for (auto c : wR.children()) {
        if (localNameEq(c, "t")) {
            std::string s = c.text().as_string();
            if (!s.empty()) out.push_back(InlineRun{kind, std::move(s), 0});
        } else if (localNameEq(c, "tab")) {
            out.push_back(InlineRun{kind, "\t", 0});
        } else if (localNameEq(c, "br") || localNameEq(c, "cr")) {
            out.push_back(InlineRun{InlineKind::LineBreak, "", 0});
        }
    }
}

void parseParagraph(const pugi::xml_node& wP, Document* out) {
    auto pPr = firstChildLocal(wP, "pPr");

    // Detect heading via style id.
    int headingLevel = 0;
    bool isListParagraph = false;
    if (pPr) {
        auto pStyle = firstChildLocal(pPr, "pStyle");
        if (pStyle) {
            std::string val = pStyle.attribute("w:val").as_string();
            if (val.empty()) val = pStyle.attribute("val").as_string();
            headingLevel = headingLevelFromStyle(val);
            if (val == "ListParagraph") isListParagraph = true;
        }
    }

    Block b;
    if (headingLevel > 0) {
        b.kind = BlockKind::Heading;
        b.level = headingLevel;
    } else if (isListParagraph) {
        b.kind = BlockKind::UnorderedItem;
    } else {
        b.kind = BlockKind::Paragraph;
    }

    for (auto c : wP.children()) {
        if (localNameEq(c, "r")) {
            appendRunInlines(c, b.runs);
        } else if (localNameEq(c, "hyperlink")) {
            // Treat hyperlink contents as inline runs of the same paragraph.
            for (auto rr : c.children()) {
                if (localNameEq(rr, "r")) appendRunInlines(rr, b.runs);
            }
        }
    }

    if (b.runs.empty()) return;
    if (out->title.empty() && b.kind == BlockKind::Heading && b.level == 1) {
        std::string flat;
        for (auto& r : b.runs) flat += r.text;
        out->title = flat;
    }
    out->blocks.push_back(std::move(b));
}

void readCoreProperties(ZipReader& zip, Document* out) {
    std::string xml;
    if (!zip.readText("docProps/core.xml", &xml)) return;
    pugi::xml_document doc;
    if (!doc.load_string(xml.c_str())) return;
    for (auto child : doc.first_child().children()) {
        const char* nm = child.name();
        if (!nm) continue;
        std::string s = nm;
        if (out->title.empty() && s.find("title") != std::string::npos) {
            out->title = child.text().as_string();
        } else if (out->author.empty() && (s.find("creator") != std::string::npos ||
                                           s.find("lastModifiedBy") != std::string::npos)) {
            out->author = child.text().as_string();
        }
    }
}

}  // namespace

bool parseDocx(const std::filesystem::path& path, Document* out, Logger* log) {
    if (!out) return false;
    ZipReader zip;
    if (!zip.open(path)) {
        if (log) log->log(LogLevel::Error, "docx", "cannot open docx");
        return false;
    }

    readCoreProperties(zip, out);

    std::string xml;
    if (!zip.readText("word/document.xml", &xml)) {
        if (log) log->log(LogLevel::Error, "docx", "word/document.xml missing");
        return false;
    }

    pugi::xml_document doc;
    if (!doc.load_string(xml.c_str())) {
        if (log) log->log(LogLevel::Error, "docx", "document.xml parse failed");
        return false;
    }

    auto body = doc.select_node("//*[local-name()='body']").node();
    if (!body) body = doc.first_child().first_child();

    for (auto child : body.children()) {
        if (localNameEq(child, "p")) {
            parseParagraph(child, out);
        }
        // <w:tbl>, <w:sectPr>, etc. are skipped for M6.
    }
    (void)kWmlNs;
    return true;
}

}  // namespace inkling

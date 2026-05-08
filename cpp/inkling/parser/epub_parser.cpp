#include "epub_parser.h"

#include <pugixml.hpp>

#include <algorithm>
#include <cstring>
#include <map>

#include "../util/zip_reader.h"

namespace inkling {

namespace {

std::string trim(const std::string& s) {
    size_t a = 0;
    while (a < s.size() && (s[a] == ' ' || s[a] == '\t' || s[a] == '\n' || s[a] == '\r')) ++a;
    size_t b = s.size();
    while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\n' || s[b - 1] == '\r')) --b;
    return s.substr(a, b - a);
}

std::string parentPath(const std::string& s) {
    size_t p = s.find_last_of('/');
    if (p == std::string::npos) return "";
    return s.substr(0, p + 1);
}

bool readContainerOpfPath(ZipReader& zip, std::string* opfPath) {
    std::string xml;
    if (!zip.readText("META-INF/container.xml", &xml)) return false;
    pugi::xml_document doc;
    if (!doc.load_string(xml.c_str())) return false;
    auto rf = doc.select_node("/container/rootfiles/rootfile").node();
    if (!rf) return false;
    *opfPath = rf.attribute("full-path").as_string();
    return !opfPath->empty();
}

void collectInlines(const pugi::xml_node& node, std::vector<InlineRun>& out,
                    InlineKind activeKind = InlineKind::Text);

void collectText(const pugi::xml_node& node, std::vector<InlineRun>& out,
                 InlineKind kind) {
    for (auto child : node.children()) {
        if (child.type() == pugi::node_pcdata || child.type() == pugi::node_cdata) {
            std::string t = child.value();
            if (!t.empty()) {
                out.push_back(InlineRun{kind, std::move(t), 0});
            }
        } else if (child.type() == pugi::node_element) {
            collectInlines(child, out, kind);
        }
    }
}

bool nameEq(const pugi::xml_node& n, const char* name) {
    return std::strcmp(n.name(), name) == 0;
}

void collectInlines(const pugi::xml_node& node, std::vector<InlineRun>& out,
                    InlineKind activeKind) {
    if (nameEq(node, "br")) {
        out.push_back(InlineRun{InlineKind::LineBreak, "", 0});
        return;
    }
    InlineKind kind = activeKind;
    if (nameEq(node, "em") || nameEq(node, "i"))      kind = InlineKind::Emphasis;
    else if (nameEq(node, "strong") || nameEq(node, "b")) kind = InlineKind::Strong;
    else if (nameEq(node, "code"))                    kind = InlineKind::Code;
    collectText(node, out, kind);
}

bool isBlockTag(const pugi::xml_node& n) {
    static const char* names[] = {
        "p", "h1", "h2", "h3", "h4", "h5", "h6",
        "ul", "ol", "li", "pre", "hr", "div", "section", "article",
        "blockquote", "header", "footer", "nav", "aside"
    };
    for (auto* nm : names) if (nameEq(n, nm)) return true;
    return false;
}

void appendBlockKind(BlockKind kind, int level, int listDepth,
                     const pugi::xml_node& node, Document* out) {
    Block b;
    b.kind = kind;
    b.level = level;
    b.listDepth = listDepth;
    collectText(node, b.runs, InlineKind::Text);
    if (b.runs.empty() && kind != BlockKind::ThematicBreak) return;
    out->blocks.push_back(std::move(b));
}

void walkBlocks(const pugi::xml_node& node, Document* out, int listDepth) {
    for (auto child : node.children()) {
        if (child.type() != pugi::node_element) continue;
        const char* n = child.name();
        if (!n) continue;

        if (n[0] == 'h' && n[1] >= '1' && n[1] <= '6' && n[2] == 0) {
            int lvl = n[1] - '0';
            appendBlockKind(BlockKind::Heading, lvl, 0, child, out);
        } else if (std::strcmp(n, "p") == 0) {
            appendBlockKind(BlockKind::Paragraph, 0, 0, child, out);
        } else if (std::strcmp(n, "hr") == 0) {
            Block b; b.kind = BlockKind::ThematicBreak;
            out->blocks.push_back(std::move(b));
        } else if (std::strcmp(n, "pre") == 0) {
            Block b;
            b.kind = BlockKind::CodeBlock;
            std::vector<InlineRun> runs;
            collectText(child, runs, InlineKind::Text);
            std::string flat;
            for (auto& r : runs) { flat += r.text; }
            b.runs.push_back(InlineRun{InlineKind::Text, std::move(flat), 0});
            out->blocks.push_back(std::move(b));
        } else if (std::strcmp(n, "ul") == 0) {
            for (auto li : child.children("li")) {
                appendBlockKind(BlockKind::UnorderedItem, 0, listDepth, li, out);
            }
        } else if (std::strcmp(n, "ol") == 0) {
            int idx = 1;
            for (auto li : child.children("li")) {
                appendBlockKind(BlockKind::OrderedItem, idx++, listDepth, li, out);
            }
        } else if (std::strcmp(n, "li") == 0) {
            appendBlockKind(BlockKind::UnorderedItem, 0, listDepth, child, out);
        } else if (isBlockTag(child)) {
            // Recursive container.
            walkBlocks(child, out, listDepth);
        } else {
            // Unknown / inline element at block level: treat as paragraph.
            appendBlockKind(BlockKind::Paragraph, 0, 0, child, out);
        }
    }
}

void parseXhtmlIntoBlocks(const std::string& xml, Document* out, Logger* log) {
    pugi::xml_document doc;
    auto res = doc.load_string(xml.c_str(), pugi::parse_default | pugi::parse_ws_pcdata_single);
    if (!res) {
        if (log) log->log(LogLevel::Warn, "epub", "xhtml parse failed; skipping");
        return;
    }
    auto body = doc.select_node("//body").node();
    if (!body) body = doc.first_child();
    walkBlocks(body, out, 0);
}

}  // namespace

bool parseEpub(const std::filesystem::path& path, Document* out, Logger* log) {
    if (!out) return false;
    ZipReader zip;
    if (!zip.open(path)) {
        if (log) log->log(LogLevel::Error, "epub", "cannot open epub");
        return false;
    }

    std::string opfPath;
    if (!readContainerOpfPath(zip, &opfPath)) {
        if (log) log->log(LogLevel::Error, "epub", "container.xml missing or unreadable");
        return false;
    }
    std::string opfXml;
    if (!zip.readText(opfPath, &opfXml)) {
        if (log) log->log(LogLevel::Error, "epub", "OPF unreadable");
        return false;
    }

    pugi::xml_document opfDoc;
    if (!opfDoc.load_string(opfXml.c_str())) {
        if (log) log->log(LogLevel::Error, "epub", "OPF parse failed");
        return false;
    }

    // Metadata
    auto md = opfDoc.select_node("//metadata").node();
    if (md) {
        for (auto t : md.children()) {
            std::string nm = t.name();
            if (nm.find("title") != std::string::npos && out->title.empty()) {
                out->title = trim(t.text().as_string());
            } else if (nm.find("creator") != std::string::npos && out->author.empty()) {
                out->author = trim(t.text().as_string());
            }
        }
    }

    // Manifest: id → href
    std::map<std::string, std::string> idToHref;
    if (auto man = opfDoc.select_node("//manifest").node()) {
        for (auto item : man.children("item")) {
            std::string id   = item.attribute("id").as_string();
            std::string href = item.attribute("href").as_string();
            if (!id.empty() && !href.empty()) idToHref.emplace(std::move(id), std::move(href));
        }
    }

    // Spine: order of itemrefs.
    std::string opfDir = parentPath(opfPath);
    auto spine = opfDoc.select_node("//spine").node();
    if (!spine) {
        if (log) log->log(LogLevel::Warn, "epub", "OPF has no spine");
        return true;  // empty doc, no content
    }
    for (auto ir : spine.children("itemref")) {
        std::string idref = ir.attribute("idref").as_string();
        auto it = idToHref.find(idref);
        if (it == idToHref.end()) continue;
        std::string href = opfDir + it->second;

        // Strip URL fragments.
        size_t hash = href.find('#');
        if (hash != std::string::npos) href = href.substr(0, hash);

        std::string xhtml;
        if (!zip.readText(href, &xhtml)) {
            if (log) log->log(LogLevel::Warn, "epub", ("missing spine entry: " + href).c_str());
            continue;
        }
        parseXhtmlIntoBlocks(xhtml, out, log);
    }
    return true;
}

}  // namespace inkling

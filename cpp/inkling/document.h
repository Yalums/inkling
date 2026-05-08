#ifndef INKLING_DOCUMENT_H_
#define INKLING_DOCUMENT_H_

#include <cstdint>
#include <string>
#include <vector>

namespace inkling {

enum class InlineKind : uint8_t {
    Text,
    Emphasis,
    Strong,
    Code,
    LineBreak,
};

struct InlineRun {
    InlineKind kind = InlineKind::Text;
    std::string text;          // UTF-8; empty for LineBreak
    int32_t sourceByteOffset = 0;
};

enum class BlockKind : uint8_t {
    Paragraph,
    Heading,
    UnorderedItem,
    OrderedItem,
    CodeBlock,
    ThematicBreak,
    PageBreak,
};

struct Block {
    BlockKind kind = BlockKind::Paragraph;
    int level = 0;             // Heading: 1..6 ; OrderedItem: number
    int listDepth = 0;
    std::vector<InlineRun> runs;
};

struct Document {
    std::string title;
    std::string author;
    std::vector<Block> blocks;
};

}  // namespace inkling

#endif  // INKLING_DOCUMENT_H_

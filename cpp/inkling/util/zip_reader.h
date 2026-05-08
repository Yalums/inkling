#ifndef INKLING_UTIL_ZIP_READER_H_
#define INKLING_UTIL_ZIP_READER_H_

#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace inkling {

// Thin RAII wrapper around minizip-ng's mz_zip_reader.
class ZipReader {
public:
    ZipReader();
    ~ZipReader();
    ZipReader(const ZipReader&) = delete;
    ZipReader& operator=(const ZipReader&) = delete;

    bool open(const std::filesystem::path& path);
    void close();

    // Read an entry into `out` by case-insensitive name match. Returns false
    // if not found or on read error.
    bool read(const std::string& entryName, std::vector<uint8_t>* out);

    // Convenience: read entry as UTF-8 string.
    bool readText(const std::string& entryName, std::string* out);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace inkling

#endif

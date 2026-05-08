#include "zip_reader.h"

#include <mz.h>
#include <mz_strm.h>
#include <mz_zip.h>
#include <mz_zip_rw.h>

namespace inkling {

struct ZipReader::Impl {
    void* reader = nullptr;
    bool  isOpen = false;
};

ZipReader::ZipReader() : impl_(std::make_unique<Impl>()) {
    impl_->reader = mz_zip_reader_create();
}

ZipReader::~ZipReader() {
    close();
    if (impl_->reader) mz_zip_reader_delete(&impl_->reader);
}

bool ZipReader::open(const std::filesystem::path& path) {
    if (!impl_->reader) return false;
    if (impl_->isOpen) close();
    int32_t rc = mz_zip_reader_open_file(impl_->reader, path.string().c_str());
    impl_->isOpen = (rc == MZ_OK);
    return impl_->isOpen;
}

void ZipReader::close() {
    if (impl_->reader && impl_->isOpen) {
        mz_zip_reader_close(impl_->reader);
        impl_->isOpen = false;
    }
}

bool ZipReader::read(const std::string& entryName, std::vector<uint8_t>* out) {
    if (!impl_->reader || !impl_->isOpen || !out) return false;
    if (mz_zip_reader_locate_entry(impl_->reader, entryName.c_str(), 1) != MZ_OK) {
        return false;
    }
    mz_zip_file* info = nullptr;
    if (mz_zip_reader_entry_get_info(impl_->reader, &info) != MZ_OK || !info) {
        return false;
    }
    if (mz_zip_reader_entry_open(impl_->reader) != MZ_OK) return false;

    out->resize((size_t)info->uncompressed_size);
    int32_t bytes = 0;
    if (info->uncompressed_size > 0) {
        bytes = mz_zip_reader_entry_read(impl_->reader, out->data(),
                                         (int32_t)info->uncompressed_size);
    }
    mz_zip_reader_entry_close(impl_->reader);
    return bytes >= 0;
}

bool ZipReader::readText(const std::string& entryName, std::string* out) {
    if (!out) return false;
    std::vector<uint8_t> buf;
    if (!read(entryName, &buf)) return false;
    out->assign(buf.begin(), buf.end());
    return true;
}

}  // namespace inkling

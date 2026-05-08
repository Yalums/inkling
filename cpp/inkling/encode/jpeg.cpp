#include "jpeg.h"

#include <turbojpeg.h>

namespace inkling {

bool encodeJpegGray(const Bitmap8& src, int quality, std::vector<uint8_t>* out) {
    if (!out || src.pixels.empty() || src.width <= 0 || src.height <= 0) return false;

    tjhandle h = tjInitCompress();
    if (!h) return false;

    unsigned char* jpegBuf = nullptr;
    unsigned long jpegSize = 0;

    int rc = tjCompress2(h,
                         src.pixels.data(),
                         src.width, src.width /*pitch*/, src.height,
                         TJPF_GRAY,
                         &jpegBuf, &jpegSize,
                         TJSAMP_GRAY,
                         quality,
                         TJFLAG_FASTDCT);

    if (rc == 0 && jpegBuf && jpegSize > 0) {
        out->assign(jpegBuf, jpegBuf + jpegSize);
    }
    if (jpegBuf) tjFree(jpegBuf);
    tjDestroy(h);
    return rc == 0;
}

}  // namespace inkling

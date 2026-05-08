#ifndef INKLING_ENCODE_JPEG_H_
#define INKLING_ENCODE_JPEG_H_

#include <cstdint>
#include <vector>

#include "../render/page_raster.h"

namespace inkling {

// Encode an 8-bit grayscale framebuffer as JPEG into `out`.
// Quality is 1..100 (libjpeg-turbo convention).
bool encodeJpegGray(const Bitmap8& src, int quality, std::vector<uint8_t>* out);

}  // namespace inkling

#endif

#ifndef INKLING_LOGGER_H_
#define INKLING_LOGGER_H_

namespace inkling {

enum class LogLevel { Debug, Info, Warn, Error };

struct Logger {
    virtual ~Logger() = default;
    virtual void log(LogLevel lvl, const char* tag, const char* msg) = 0;
};

class NullLogger : public Logger {
public:
    void log(LogLevel, const char*, const char*) override {}
};

}  // namespace inkling

#endif  // INKLING_LOGGER_H_

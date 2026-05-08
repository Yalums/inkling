#ifndef INKLING_UTIL_THREAD_POOL_H_
#define INKLING_UTIL_THREAD_POOL_H_

#include <atomic>
#include <condition_variable>
#include <functional>
#include <future>
#include <mutex>
#include <queue>
#include <thread>
#include <type_traits>
#include <vector>

namespace inkling {

// Fixed-size thread pool. submit() returns a std::future for the task's
// return value. Destructor signals shutdown and joins all workers — any
// in-flight tasks complete first.
class ThreadPool {
public:
    explicit ThreadPool(int threads) : stop_(false) {
        if (threads < 1) threads = 1;
        workers_.reserve((size_t)threads);
        for (int i = 0; i < threads; ++i) {
            workers_.emplace_back([this] { runWorker(); });
        }
    }

    ~ThreadPool() {
        {
            std::lock_guard<std::mutex> lk(mu_);
            stop_ = true;
        }
        cv_.notify_all();
        for (auto& w : workers_) if (w.joinable()) w.join();
    }

    ThreadPool(const ThreadPool&) = delete;
    ThreadPool& operator=(const ThreadPool&) = delete;

    template <typename F, typename... Args>
    auto submit(F&& fn, Args&&... args) -> std::future<typename std::invoke_result<F, Args...>::type> {
        using R = typename std::invoke_result<F, Args...>::type;
        auto task = std::make_shared<std::packaged_task<R()>>(
            std::bind(std::forward<F>(fn), std::forward<Args>(args)...));
        std::future<R> fut = task->get_future();
        {
            std::lock_guard<std::mutex> lk(mu_);
            tasks_.emplace([task]() { (*task)(); });
        }
        cv_.notify_one();
        return fut;
    }

private:
    void runWorker() {
        for (;;) {
            std::function<void()> task;
            {
                std::unique_lock<std::mutex> lk(mu_);
                cv_.wait(lk, [this] { return stop_ || !tasks_.empty(); });
                if (stop_ && tasks_.empty()) return;
                task = std::move(tasks_.front());
                tasks_.pop();
            }
            task();
        }
    }

    std::vector<std::thread>          workers_;
    std::queue<std::function<void()>> tasks_;
    std::mutex                        mu_;
    std::condition_variable           cv_;
    bool                              stop_;
};

}  // namespace inkling

#endif

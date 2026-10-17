#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include "lifetime_sink_v1.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

_Static_assert(sizeof(off_t) >= sizeof(int64_t), "receiver needs signed 64-bit file offsets");
_Static_assert((off_t)-1 < (off_t)0, "receiver needs signed file offsets");

#ifdef LJ_TEST_IO
/* Negative-only fault build. Positive proof compiles without this macro. */
extern ssize_t lj_test_write_v1(int, const void *, size_t);
extern int lj_test_fsync_v1(int);
#define RECEIVER_WRITE lj_test_write_v1
#define RECEIVER_FSYNC lj_test_fsync_v1
#else
#define RECEIVER_WRITE write
#define RECEIVER_FSYNC fsync
#endif

static bool cookie_equal(lj_cookie_v1 a, lj_cookie_v1 b) { return a.hi == b.hi && a.lo == b.lo; }
static bool cookie_valid(lj_cookie_v1 a) { return a.hi != 0U || a.lo != 0U; }
static bool private_file(lj_sink_v1 *s, int fd) {
    struct stat st;
    const int flags = fcntl(fd, F_GETFL), descriptor = fcntl(fd, F_GETFD);
    return fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_uid == s->owner_uid
        && st.st_dev == s->device && st.st_ino == s->inode && st.st_nlink == 1
        && (st.st_mode & 07777U) == 0600U && flags >= 0 && descriptor >= 0
        && (flags & O_ACCMODE) == O_WRONLY && (flags & O_APPEND) != 0
        && (descriptor & FD_CLOEXEC) != 0;
}
static bool same_description(lj_sink_v1 *s) {
    const off_t original = lseek(s->fd, 0, SEEK_CUR);
    if (original < 0 || lseek(s->guard_fd, 0, SEEK_CUR) != original) return false;
    const off_t probe = original == 0 ? 1 : 0;
    if (lseek(s->fd, probe, SEEK_SET) != probe) return false;
    const bool coupled = lseek(s->guard_fd, 0, SEEK_CUR) == probe;
    const bool restored = lseek(s->fd, original, SEEK_SET) == original;
    return coupled && restored && lseek(s->guard_fd, 0, SEEK_CUR) == original;
}
static lj_result_v1 hold(lj_sink_v1 *s) {
    atomic_store_explicit(&s->held, true, memory_order_release);
    atomic_store_explicit(&s->ready, false, memory_order_release);
    return LJ_HELD_V1;
}
lj_result_v1 lj_sink_create_v1(lj_sink_v1 *s, int dirfd, const char *name, lj_cookie_v1 domain) {
    struct stat parent, file;
    if (s == NULL) return LJ_HELD_V1;
    if (s->self != NULL) return hold(s);
    if (!cookie_valid(domain) || name == NULL) return LJ_HELD_V1;
    const size_t n = strlen(name);
    if (n == 0U || n > 64U || name[0] == '.') return LJ_HELD_V1;
    for (size_t i = 0U; i < n; ++i) {
        const unsigned char c = (unsigned char)name[i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '_' || c == '-' || c == '.')) return LJ_HELD_V1;
    }
    if (fstat(dirfd, &parent) != 0 || !S_ISDIR(parent.st_mode) || parent.st_uid != geteuid()
        || (parent.st_mode & 07777U) != 0700U) return LJ_HELD_V1;
    s->self = s; s->owner_pid = getpid(); s->owner_uid = geteuid(); s->domain = domain;
    s->fd = openat(dirfd, name, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (s->fd < 0 || fstat(s->fd, &file) != 0 || !S_ISREG(file.st_mode)
        || file.st_size != 0 || file.st_nlink != 1 || (file.st_mode & 07777U) != 0600U) return hold(s);
    s->device = file.st_dev; s->inode = file.st_ino;
    s->guard_fd = dup(s->fd);
    if (s->guard_fd < 0 || fcntl(s->guard_fd, F_SETFD, FD_CLOEXEC) != 0
        || RECEIVER_FSYNC(s->fd) != 0 || RECEIVER_FSYNC(dirfd) != 0) return hold(s);
    s->bytes = 0U; s->sequence = 0U;
    atomic_store_explicit(&s->ready, true, memory_order_release);
    return LJ_OK_V1;
}
lj_result_v1 lj_sink_append_internal_v1(lj_sink_v1 *s, lj_cookie_v1 domain,
                                       uint64_t sequence, const unsigned char *record) {
    if (s == NULL || s->self != s || record == NULL) return LJ_HELD_V1;
    if (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) return LJ_BUSY_V1;
    lj_result_v1 result = LJ_HELD_V1;
    struct stat st;
    if (!atomic_load_explicit(&s->ready, memory_order_acquire)
        || atomic_load_explicit(&s->held, memory_order_acquire) || s->owner_pid != getpid()
        || !cookie_equal(s->domain, domain) || s->sequence == UINT64_MAX
        || sequence != s->sequence + 1U || s->bytes > (uint64_t)INT64_MAX - LJ_RECEIPT_BYTES_V1
        || !private_file(s, s->fd) || !private_file(s, s->guard_fd) || !same_description(s)
        || fstat(s->fd, &st) != 0 || st.st_size < 0 || (uint64_t)st.st_size != s->bytes
        || lseek(s->fd, 0, SEEK_CUR) != (off_t)s->bytes) goto finish;
    /* One strict attempt. Short/EINTR/unknown write never retries or refunds. */
    if (RECEIVER_WRITE(s->fd, record, LJ_RECEIPT_BYTES_V1) != (ssize_t)LJ_RECEIPT_BYTES_V1
        || RECEIVER_FSYNC(s->fd) != 0) goto finish;
    if (!atomic_load_explicit(&s->ready, memory_order_acquire)
        || atomic_load_explicit(&s->held, memory_order_acquire)
        || !private_file(s, s->fd) || !private_file(s, s->guard_fd) || !same_description(s)
        || fstat(s->fd, &st) != 0 || st.st_size < 0
        || (uint64_t)st.st_size != s->bytes + LJ_RECEIPT_BYTES_V1
        || lseek(s->fd, 0, SEEK_CUR) != (off_t)(s->bytes + LJ_RECEIPT_BYTES_V1)) goto finish;
    s->bytes += LJ_RECEIPT_BYTES_V1; s->sequence = sequence; result = LJ_OK_V1;
finish:
    if (result != LJ_OK_V1) (void)hold(s);
    atomic_flag_clear_explicit(&s->lock, memory_order_release);
    return result;
}
void lj_sink_close_v1(lj_sink_v1 *s) {
    if (s == NULL || s->self != s) return;
    if (atomic_flag_test_and_set_explicit(&s->lock, memory_order_acquire)) { (void)hold(s); return; }
    (void)hold(s);
    if (s->owner_pid == getpid()) {
        if (private_file(s, s->fd) && private_file(s, s->guard_fd) && same_description(s)) (void)close(s->fd);
        /* The guard is private controller storage and must never be adopted/closed by callers. */
        if (private_file(s, s->guard_fd)) (void)close(s->guard_fd);
    }
    s->fd = -1; s->guard_fd = -1;
    atomic_flag_clear_explicit(&s->lock, memory_order_release);
}

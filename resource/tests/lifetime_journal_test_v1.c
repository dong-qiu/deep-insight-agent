#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include "../core/lifetime_journal_v1.h"
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static atomic_uint checks;
static unsigned groups, file_number;
static int directory;
static const lj_cookie_v1 DOMAIN = {1U, 2U}, OBSERVER = {3U, 4U};
static const lj_cookie_v1 PARENT = {5U, 6U}, TRACER = {7U, 8U};
#define CHECK(x) do { ++checks; if (!(x)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #x); exit(1); } } while (0)
typedef struct { lj_domain_v1 domain; lj_sink_v1 sink; lj_slot_v1 slots[LJ_TASK_CAP_V1]; char name[64]; } fixture;
static void start(fixture *f, size_t cap) {
    *f = (fixture){ .domain = LJ_DOMAIN_V1_INITIALIZER, .sink = LJ_SINK_V1_INITIALIZER };
    const int n = snprintf(f->name, sizeof(f->name), "receipt-%u.bin", ++file_number);
    CHECK(n > 0 && (size_t)n < sizeof(f->name));
    CHECK(lj_sink_create_v1(&f->sink, directory, f->name, DOMAIN) == LJ_OK_V1);
    CHECK(lj_init_v1(&f->domain, f->slots, cap, cap * 2U, DOMAIN, OBSERVER, &f->sink) == LJ_OK_V1);
}
static lj_ticket_v1 reserve(fixture *f, uint64_t id) {
    lj_ticket_v1 ticket;
    CHECK(lj_reserve_v1(&f->domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, id}, PARENT, TRACER, &ticket) == LJ_OK_V1);
    return ticket;
}
static lj_cookie_v1 actor(lj_event_v1 event) {
    return event == LJ_TRACER_WAIT_V1 ? TRACER : event == LJ_REAL_PARENT_REAP_V1 ? PARENT : OBSERVER;
}
static void report(fixture *f, const lj_ticket_v1 *t, lj_event_v1 event, uint64_t ordinal) {
    CHECK(lj_report_v1(&f->domain, t, event, ordinal, actor(event)) == LJ_OK_V1);
}
static void complete(fixture *f, const lj_ticket_v1 *t) {
    for (unsigned i = 0U; i < 6U; ++i) report(f, t, (lj_event_v1)i, (uint64_t)i + 1U);
}
static void state(fixture *f, size_t active, bool held) {
    const lj_snapshot_v1 s = lj_snapshot_v1_get(&f->domain);
    CHECK(s.active == active && s.record_units == active * 2U && s.held == held && !s.original_qualification);
}
#ifndef LJ_TEST_IO
static uint64_t read_word(const unsigned char *data) {
    uint64_t value = 0U;
    for (unsigned i = 0U; i < 8U; ++i) value = (value << 8U) | data[i];
    return value;
}
static void file_bytes(fixture *f, size_t count) {
    struct stat st;
    const int fd = openat(directory, f->name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    CHECK(fd >= 0 && fstat(fd, &st) == 0 && st.st_size >= 0);
    CHECK((uint64_t)st.st_size == (uint64_t)count * LJ_RECEIPT_BYTES_V1);
    if (count > 0U) {
        unsigned char bytes[LJ_RECEIPT_BYTES_V1];
        CHECK(lseek(fd, (off_t)((count - 1U) * LJ_RECEIPT_BYTES_V1), SEEK_SET) >= 0);
        CHECK(read(fd, bytes, sizeof(bytes)) == (ssize_t)sizeof(bytes));
        CHECK(memcmp(bytes, "LJRSRV01", 8U) == 0 && memcmp(bytes + LJ_RECORD_BYTES_V1, "LJTERM01", 8U) == 0);
        CHECK(read_word(bytes + 8U) == LJ_RECORD_BYTES_V1 && read_word(bytes + LJ_RECORD_BYTES_V1 + 8U) == LJ_RECORD_BYTES_V1);
        CHECK(memcmp(bytes + 16U, bytes + LJ_RECORD_BYTES_V1 + 16U, 40U) == 0);
        CHECK(read_word(bytes + 16U) == DOMAIN.hi && read_word(bytes + 24U) == DOMAIN.lo);
        CHECK(read_word(bytes + 32U) > 0U && read_word(bytes + 40U) > 0U);
        CHECK(read_word(bytes + 128U) == 1U && read_word(bytes + LJ_RECORD_BYTES_V1 + 128U) == 1U);
    }
    CHECK(close(fd) == 0);
}
#endif
static void finish(fixture *f, const char *name) {
    lj_sink_close_v1(&f->sink); ++groups; printf("PASS lifetime %s\n", name);
}

#ifndef LJ_TEST_IO
static void durable_reuse(void) {
    fixture f; start(&f, 1U); lj_ticket_v1 old = {0};
    for (uint64_t i = 1U; i <= 64U; ++i) {
        lj_ticket_v1 t = reserve(&f, i); state(&f, 1U, false);
        CHECK(t.birth_id == i && t.generation == i);
        complete(&f, &t); state(&f, 1U, false); file_bytes(&f, (size_t)i - 1U);
        CHECK(lj_flush_v1(&f.domain, &t) == LJ_OK_V1); state(&f, 0U, false); file_bytes(&f, (size_t)i);
        old = t;
    }
    const lj_ticket_v1 current = reserve(&f, 65U);
    CHECK(lj_report_v1(&f.domain, &old, LJ_BIRTH_V1, 1U, OBSERVER) == LJ_HELD_V1);
    CHECK(!f.slots[current.slot].quarantined); state(&f, 1U, true);
    finish(&f, "real-write-fsync-64-reuses-and-stale-generation");
}
static void capacities(void) {
    fixture f; start(&f, LJ_TASK_CAP_V1);
    for (uint64_t i = 1U; i <= LJ_TASK_CAP_V1; ++i) { (void)reserve(&f, i); state(&f, (size_t)i, false); }
    lj_ticket_v1 extra;
    CHECK(lj_reserve_v1(&f.domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, 99U}, PARENT, TRACER, &extra) == LJ_DENIED_V1);
    state(&f, LJ_TASK_CAP_V1, false); file_bytes(&f, 0U); finish(&f, "cap-minus-exact-plus-one-backpressure");
    start(&f, 1U);
    lj_domain_v1 other = LJ_DOMAIN_V1_INITIALIZER;
    lj_slot_v1 slots[17];
    CHECK(lj_init_v1(&other, slots, 17U, 34U, DOMAIN, OBSERVER, &f.sink) == LJ_HELD_V1);
    other = (lj_domain_v1)LJ_DOMAIN_V1_INITIALIZER;
    CHECK(lj_init_v1(&other, slots, 1U, 1U, DOMAIN, OBSERVER, &f.sink) == LJ_HELD_V1);
    other = (lj_domain_v1)LJ_DOMAIN_V1_INITIALIZER;
    CHECK(lj_init_v1(&other, slots, 1U, 2U, DOMAIN, OBSERVER, &f.sink) == LJ_HELD_V1);
    finish(&f, "terminal-reservation-hardcap-and-single-sink-binding");
}
static void cancellation(void) {
    fixture f; start(&f, 1U); lj_ticket_v1 t = reserve(&f, 1U);
    report(&f, &t, LJ_NO_BIRTH_V1, 1U); state(&f, 1U, false);
    CHECK(lj_flush_v1(&f.domain, &t) == LJ_OK_V1); state(&f, 0U, false); file_bytes(&f, 1U);
    finish(&f, "known-no-birth-still-needs-real-ack");
    start(&f, 1U); t = reserve(&f, 2U); report(&f, &t, LJ_NO_BIRTH_V1, 1U);
    CHECK(lj_report_v1(&f.domain, &t, LJ_EXEC_V1, 2U, OBSERVER) == LJ_HELD_V1);
    CHECK(lj_flush_v1(&f.domain, &t) == LJ_HELD_V1); state(&f, 1U, true); file_bytes(&f, 0U);
    finish(&f, "no-birth-cannot-later-become-exec");
    start(&f, 1U); t = reserve(&f, 3U); CHECK(lj_unknown_v1(&f.domain, &t) == LJ_HELD_V1);
    CHECK(lj_report_v1(&f.domain, &t, LJ_NO_BIRTH_V1, 1U, OBSERVER) == LJ_HELD_V1);
    state(&f, 1U, true); finish(&f, "unknown-birth-never-cancels");
}
static void report_failures(void) {
    const char *names[] = {"exec-before-birth", "ordinal-gap", "wrong-observer", "cross-domain", "duplicate-birth", "tracer-wait-before-exit", "wrong-real-parent", "missing-kernel-release", "missing-parent-reap", "missing-tracer-wait"};
    for (unsigned mode = 0U; mode < 10U; ++mode) {
        fixture f; start(&f, 1U); lj_ticket_v1 t = reserve(&f, 1U);
        lj_result_v1 result = LJ_OK_V1;
        if (mode == 0U) result = lj_report_v1(&f.domain, &t, LJ_EXEC_V1, 1U, OBSERVER);
        if (mode == 1U) result = lj_report_v1(&f.domain, &t, LJ_BIRTH_V1, 2U, OBSERVER);
        if (mode == 2U) result = lj_report_v1(&f.domain, &t, LJ_BIRTH_V1, 1U, PARENT);
        if (mode == 3U) { t.domain.lo++; result = lj_report_v1(&f.domain, &t, LJ_BIRTH_V1, 1U, OBSERVER); }
        if (mode == 4U) { report(&f, &t, LJ_BIRTH_V1, 1U); result = lj_report_v1(&f.domain, &t, LJ_BIRTH_V1, 2U, OBSERVER); }
        if (mode == 5U) { report(&f, &t, LJ_BIRTH_V1, 1U); result = lj_report_v1(&f.domain, &t, LJ_TRACER_WAIT_V1, 2U, TRACER); }
        if (mode >= 6U) {
            for (unsigned i = 0U; i < 3U; ++i) report(&f, &t, (lj_event_v1)i, (uint64_t)i + 1U);
            if (mode == 6U) result = lj_report_v1(&f.domain, &t, LJ_REAL_PARENT_REAP_V1, 4U, TRACER);
            else {
                const unsigned missing = mode == 7U ? 3U : mode == 8U ? 5U : 4U;
                uint64_t ordinal = 4U;
                for (unsigned i = 3U; i < 6U; ++i) if (i != missing) report(&f, &t, (lj_event_v1)i, ordinal++);
                result = lj_flush_v1(&f.domain, &t);
            }
        }
        CHECK(result == LJ_HELD_V1); state(&f, 1U, true); file_bytes(&f, 0U); finish(&f, names[mode]);
    }
}
static void independent_terminal_order(void) {
    fixture f; start(&f, 1U); const lj_ticket_v1 t = reserve(&f, 1U);
    report(&f, &t, LJ_BIRTH_V1, 1U); report(&f, &t, LJ_EXEC_V1, 2U); report(&f, &t, LJ_EXIT_V1, 3U);
    report(&f, &t, LJ_REAL_PARENT_REAP_V1, 4U); report(&f, &t, LJ_KERNEL_RELEASE_V1, 5U); report(&f, &t, LJ_TRACER_WAIT_V1, 6U);
    CHECK(lj_flush_v1(&f.domain, &t) == LJ_OK_V1); file_bytes(&f, 1U); finish(&f, "independent-terminal-obligations");
}
static void honest_cleanup(void) {
    fixture f; start(&f, 2U); const lj_ticket_v1 bad = reserve(&f, 1U), good = reserve(&f, 2U);
    CHECK(lj_unknown_v1(&f.domain, &bad) == LJ_HELD_V1); complete(&f, &good);
    CHECK(lj_flush_v1(&f.domain, &good) == LJ_OK_V1); state(&f, 1U, true); file_bytes(&f, 1U);
    lj_ticket_v1 next;
    CHECK(lj_reserve_v1(&f.domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, 3U}, PARENT, TRACER, &next) == LJ_HELD_V1);
    CHECK(lj_flush_v1(&f.domain, &bad) == LJ_HELD_V1); finish(&f, "honest-sibling-cleanup-never-clears-hold");
}
static void wrap_and_unsupported(void) {
    for (unsigned mode = 0U; mode < 6U; ++mode) {
        fixture f; start(&f, 1U); lj_ticket_v1 t;
        /* Trusted arithmetic fixtures, not an assertion of actual kernel ID lifetime. */
        if (mode == 0U) f.domain.birth_id = UINT64_MAX;
        if (mode == 1U) f.slots[0].generation = UINT64_MAX;
        if (mode == 2U) { f.domain.flush_sequence = UINT64_MAX; f.sink.sequence = UINT64_MAX; }
        if (mode == 3U) f.sink.bytes = (uint64_t)INT64_MAX - 100U;
        CHECK(lj_reserve_v1(&f.domain, mode == 4U ? (lj_kind_v1)2 : LJ_WAITABLE_EXEC_CHILD_V1,
              mode == 5U ? (lj_cookie_v1){0U, 0U} : (lj_cookie_v1){10U, 1U}, PARENT, TRACER, &t) == LJ_HELD_V1);
        state(&f, 0U, true); finish(&f, "prebirth-wrap-or-unsupported-refusal");
    }
}
static void receiver_identity(void) {
    for (unsigned mode = 0U; mode < 4U; ++mode) {
        fixture f; start(&f, 1U); const lj_ticket_v1 t = reserve(&f, 1U); complete(&f, &t);
        int replacement = -1;
        if (mode == 0U) {
            const int original = f.sink.fd; CHECK(close(original) == 0);
            replacement = openat(directory, f.name, O_WRONLY | O_APPEND | O_CLOEXEC | O_NOFOLLOW);
            CHECK(replacement >= 0);
            if (replacement != original) { CHECK(dup2(replacement, original) == original); CHECK(close(replacement) == 0); replacement = original; CHECK(fcntl(original, F_SETFD, FD_CLOEXEC) == 0); }
        }
        if (mode == 1U) CHECK(fchmod(f.sink.fd, 0640) == 0);
        if (mode == 2U) CHECK(write(f.sink.fd, "x", 1U) == 1);
        if (mode == 3U) CHECK(lj_sink_create_v1(&f.sink, directory, "retry.bin", DOMAIN) == LJ_HELD_V1);
        CHECK(lj_flush_v1(&f.domain, &t) == LJ_HELD_V1); state(&f, 1U, true);
        if (mode == 1U) CHECK(fchmod(f.sink.fd, 0600) == 0);
        if (replacement >= 0) CHECK(close(replacement) == 0);
        finish(&f, "receiver-fd-mode-size-or-reinit-rejected");
    }
}
typedef struct { fixture *f; uint64_t id; lj_result_v1 result; lj_ticket_v1 ticket; atomic_uint *ready; atomic_bool *go; } contender;
static void *compete(void *arg) {
    contender *c = arg; atomic_fetch_add_explicit(c->ready, 1U, memory_order_release);
    while (!atomic_load_explicit(c->go, memory_order_acquire)) { }
    c->result = lj_reserve_v1(&c->f->domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, c->id}, PARENT, TRACER, &c->ticket);
    return NULL;
}
static void races(void) {
    fixture f; start(&f, 1U);
    for (unsigned round = 0U; round < 32U; ++round) {
        atomic_uint ready = 0U; atomic_bool go = false;
        contender a = {&f, (uint64_t)round * 2U + 1U, LJ_HELD_V1, {0}, &ready, &go};
        contender b = {&f, (uint64_t)round * 2U + 2U, LJ_HELD_V1, {0}, &ready, &go};
        pthread_t ta, tb; CHECK(pthread_create(&ta, NULL, compete, &a) == 0); CHECK(pthread_create(&tb, NULL, compete, &b) == 0);
        while (atomic_load_explicit(&ready, memory_order_acquire) != 2U) { }
        atomic_store_explicit(&go, true, memory_order_release);
        CHECK(pthread_join(ta, NULL) == 0); CHECK(pthread_join(tb, NULL) == 0);
        CHECK((a.result == LJ_OK_V1 && b.result == LJ_DENIED_V1) || (b.result == LJ_OK_V1 && a.result == LJ_DENIED_V1));
        const lj_ticket_v1 *winner = a.result == LJ_OK_V1 ? &a.ticket : &b.ticket;
        complete(&f, winner); CHECK(lj_flush_v1(&f.domain, winner) == LJ_OK_V1); state(&f, 0U, false);
    }
    file_bytes(&f, 32U); finish(&f, "32-two-contender-rounds-max-three-pthreads");
}
#else
static unsigned fault;
static pthread_mutex_t io_mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t io_condition = PTHREAD_COND_INITIALIZER;
static bool io_entered, io_release;
ssize_t lj_test_write_v1(int fd, const void *data, size_t size);
int lj_test_fsync_v1(int fd);
ssize_t lj_test_write_v1(int fd, const void *data, size_t size) {
    if (fault == 1U) return write(fd, data, size / 2U);
    if (fault == 2U) { errno = EINTR; return -1; }
    if (fault == 3U) { errno = EIO; return -1; }
    if (fault >= 5U) {
        CHECK(pthread_mutex_lock(&io_mutex) == 0); io_entered = true;
        CHECK(pthread_cond_broadcast(&io_condition) == 0);
        while (!io_release) CHECK(pthread_cond_wait(&io_condition, &io_mutex) == 0);
        CHECK(pthread_mutex_unlock(&io_mutex) == 0);
    }
    return write(fd, data, size);
}
int lj_test_fsync_v1(int fd) {
    if (fault == 4U) { CHECK(close(fd) == 0); return fsync(fd); }
    return fsync(fd);
}
static void negative_io(void) {
    for (unsigned mode = 1U; mode <= 4U; ++mode) {
        fault = 0U; fixture f; start(&f, 1U); const lj_ticket_v1 t = reserve(&f, mode); complete(&f, &t); fault = mode;
        CHECK(lj_flush_v1(&f.domain, &t) == LJ_HELD_V1); state(&f, 1U, true);
        struct stat st; CHECK(fstatat(directory, f.name, &st, AT_SYMLINK_NOFOLLOW) == 0);
        CHECK(st.st_size == (mode == 1U ? 256 : mode == 4U ? 512 : 0));
        CHECK(f.sink.bytes == 0U && f.sink.sequence == 0U);
        lj_ticket_v1 next;
        CHECK(lj_reserve_v1(&f.domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, 99U}, PARENT, TRACER, &next) == LJ_HELD_V1);
        CHECK(lj_flush_v1(&f.domain, &t) == LJ_HELD_V1);
        fault = 0U; finish(&f, "negative-only-partial-eintr-eio-real-ebadf-fsync");
    }
}
typedef struct { fixture *f; lj_ticket_v1 ticket; lj_result_v1 result; } flush_job;
static void *flush_thread(void *arg) {
    flush_job *job = arg; job->result = lj_flush_v1(&job->f->domain, &job->ticket); return NULL;
}
static void inflight_boundary(void) {
    for (unsigned mode = 5U; mode <= 7U; ++mode) {
        fault = 0U; fixture f; start(&f, 2U); const lj_ticket_v1 ticket = reserve(&f, 1U); complete(&f, &ticket);
        io_entered = false; io_release = false; fault = mode;
        flush_job job = {&f, ticket, LJ_HELD_V1}; pthread_t thread;
        CHECK(pthread_create(&thread, NULL, flush_thread, &job) == 0);
        CHECK(pthread_mutex_lock(&io_mutex) == 0);
        while (!io_entered) CHECK(pthread_cond_wait(&io_condition, &io_mutex) == 0);
        CHECK(pthread_mutex_unlock(&io_mutex) == 0);
        const lj_snapshot_v1 pending = lj_snapshot_v1_get(&f.domain);
        CHECK(pending.inflight && pending.active == 1U && pending.record_units == 2U);
        lj_ticket_v1 next;
        CHECK(lj_reserve_v1(&f.domain, LJ_WAITABLE_EXEC_CHILD_V1, (lj_cookie_v1){10U, 99U}, PARENT, TRACER, &next) == LJ_BUSY_V1);
        if (mode == 6U) CHECK(lj_report_v1(&f.domain, &ticket, LJ_EXIT_V1, 7U, OBSERVER) == LJ_HELD_V1);
        if (mode == 7U) lj_sink_close_v1(&f.sink);
        CHECK(pthread_mutex_lock(&io_mutex) == 0); io_release = true;
        CHECK(pthread_cond_broadcast(&io_condition) == 0); CHECK(pthread_mutex_unlock(&io_mutex) == 0);
        CHECK(pthread_join(thread, NULL) == 0);
        CHECK(job.result == (mode == 5U ? LJ_OK_V1 : LJ_HELD_V1));
        state(&f, mode == 5U ? 0U : 1U, mode != 5U);
        struct stat st; CHECK(fstatat(directory, f.name, &st, AT_SYMLINK_NOFOLLOW) == 0 && st.st_size == 512);
        fault = 0U; finish(&f, "fault-build-inflight-unlocked-io-pinned-intent-and-close-race");
    }
}
#endif
int main(int argc, char **argv) {
    CHECK(argc == 2); directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW); CHECK(directory >= 0);
    (void)umask(0077);
#ifndef LJ_TEST_IO
    durable_reuse(); capacities(); cancellation(); report_failures(); independent_terminal_order();
    honest_cleanup(); wrap_and_unsupported(); receiver_identity(); races();
#else
    negative_io(); inflight_boundary();
#endif
    CHECK(close(directory) == 0); printf("lifetime groups=%u checks=%u qualification=false\n", groups, atomic_load_explicit(&checks, memory_order_relaxed)); return 0;
}

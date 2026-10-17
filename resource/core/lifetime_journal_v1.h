#ifndef RESOURCE_LIFETIME_JOURNAL_V1_H
#define RESOURCE_LIFETIME_JOURNAL_V1_H
#include <stdatomic.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>

#define LJ_TASK_CAP_V1 16U
#define LJ_RECORD_BYTES_V1 256U
#define LJ_RECEIPT_BYTES_V1 (2U * LJ_RECORD_BYTES_V1)
typedef struct { uint64_t hi, lo; } lj_cookie_v1;
typedef enum { LJ_OK_V1, LJ_DENIED_V1, LJ_BUSY_V1, LJ_HELD_V1 } lj_result_v1;
typedef enum { LJ_WAITABLE_EXEC_CHILD_V1 = 1 } lj_kind_v1;
typedef enum {
    LJ_BIRTH_V1 = 0, LJ_EXEC_V1, LJ_EXIT_V1, LJ_KERNEL_RELEASE_V1,
    LJ_TRACER_WAIT_V1, LJ_REAL_PARENT_REAP_V1, LJ_NO_BIRTH_V1
} lj_event_v1;
typedef struct {
    lj_cookie_v1 domain, task, parent, tracer;
    uint64_t birth_id, generation;
    size_t slot;
} lj_ticket_v1;

/* Caller-owned trusted storage, NOT an adoption/mutation API. No copy/fork/reinit
 * of a live controller/context. Cookies are reported identities, NOT kernel proof.
 * Call arguments must be stable and disjoint from controller/slot/sink storage;
 * initialize and close only under the controller owner's lifecycle exclusion. */
typedef struct {
    atomic_flag lock;
    atomic_bool ready, held;
    atomic_uintptr_t bound_domain;
    const void *self;
    int fd, guard_fd;
    pid_t owner_pid;
    uid_t owner_uid;
    dev_t device;
    ino_t inode;
    uint64_t bytes, sequence;
    lj_cookie_v1 domain;
} lj_sink_v1;
#define LJ_SINK_V1_INITIALIZER { .lock = ATOMIC_FLAG_INIT, .ready = false, .held = false, .fd = -1, .guard_fd = -1 }

typedef struct {
    bool active, quarantined, flushing;
    uint64_t generation, ordinal, event_sequence[7];
    unsigned mask;
    lj_ticket_v1 ticket;
    unsigned char records[LJ_RECEIPT_BYTES_V1];
} lj_slot_v1;
typedef struct {
    atomic_flag lock;
    const void *self;
    bool initialized, held, inflight;
    lj_cookie_v1 domain, observer;
    lj_sink_v1 *sink;
    lj_slot_v1 *slots;
    size_t capacity, active;
    uint64_t birth_id, flush_sequence, inflight_birth;
} lj_domain_v1;
#define LJ_DOMAIN_V1_INITIALIZER { .lock = ATOMIC_FLAG_INIT }
typedef struct { size_t active, record_units; bool held, inflight, original_qualification; } lj_snapshot_v1;

lj_result_v1 lj_sink_create_v1(lj_sink_v1 *, int private_dir_fd, const char *name, lj_cookie_v1);
void lj_sink_close_v1(lj_sink_v1 *);
lj_result_v1 lj_init_v1(lj_domain_v1 *, lj_slot_v1 *, size_t slots, size_t record_units,
                       lj_cookie_v1 domain, lj_cookie_v1 observer, lj_sink_v1 *);
lj_result_v1 lj_reserve_v1(lj_domain_v1 *, lj_kind_v1, lj_cookie_v1 task,
                          lj_cookie_v1 parent, lj_cookie_v1 tracer, lj_ticket_v1 *);
lj_result_v1 lj_report_v1(lj_domain_v1 *, const lj_ticket_v1 *, lj_event_v1,
                         uint64_t ordinal, lj_cookie_v1 reporter);
lj_result_v1 lj_unknown_v1(lj_domain_v1 *, const lj_ticket_v1 *);
/* No ACK boolean: this performs real receiver I/O outside the core lock. */
lj_result_v1 lj_flush_v1(lj_domain_v1 *, const lj_ticket_v1 *);
lj_snapshot_v1 lj_snapshot_v1_get(lj_domain_v1 *);
#endif

#ifndef RESOURCE_IO_BUDGET_V1_H
#define RESOURCE_IO_BUDGET_V1_H
#include "policy_v1.h"
#include <stdatomic.h>
#include <stdbool.h>

typedef struct { uint64_t hi, lo; } io_cookie_v1;
typedef enum { IO_NULL_V1, IO_ZERO_V1, IO_URANDOM_V1, IO_STDOUT_V1, IO_STDERR_V1 } io_object_v1;
typedef enum { IO_READ_V1, IO_WRITE_V1 } io_direction_v1;
typedef enum { IO_ALLOWED_V1, IO_DENIED_V1, IO_HELD_V1, IO_INVALID_V1 } io_status_v1;
typedef struct {
    io_cookie_v1 domain, task, object;
    uint64_t operation_id;
    io_object_v1 object_class;
    io_direction_v1 direction;
    uint64_t requested;
} io_request_v1;
typedef struct {
    io_cookie_v1 domain, task, object;
    uint64_t operation_id, generation;
    size_t slot;
} io_ticket_v1;
typedef struct {
    bool active, unknown;
    uint64_t operation_id, generation, reserved;
    io_cookie_v1 task, object;
    unsigned mask;
} io_slot_v1;

/* TCB-owned storage: initialize once; never copy/move/tamper with a live context.
 * All API access is serialized; caller orders strictly increasing operation IDs.
 * No OS identities, effects or crash-persistence are supplied by this C core. */
typedef struct {
    atomic_flag lock;
    bool initialized, held;
    io_cookie_v1 domain;
    uint64_t high_operation_id;
    uint64_t used[8], caps[8];
    io_slot_v1 *slots;
    size_t capacity;
} io_domain_v1;
#define IO_DOMAIN_V1_INITIALIZER { .lock = ATOMIC_FLAG_INIT }
typedef struct { bool held; uint64_t used[8], high_operation_id; } io_snapshot_v1;

io_status_v1 io_init_v1(io_domain_v1 *d, const rp_policy_v1 *policy,
                       io_cookie_v1 domain, io_slot_v1 *slots, size_t capacity);
io_status_v1 io_reserve_v1(io_domain_v1 *d, const io_request_v1 *request, io_ticket_v1 *out);
io_status_v1 io_complete_v1(io_domain_v1 *d, const io_ticket_v1 *ticket, bool known, uint64_t actual);
io_status_v1 io_snapshot_get_v1(io_domain_v1 *d, io_snapshot_v1 *out);
#endif

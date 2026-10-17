#include "io_budget_v1.h"
#include <string.h>

static void lock_domain(io_domain_v1 *d) {
    while (atomic_flag_test_and_set_explicit(&d->lock, memory_order_acquire)) { }
}
static void unlock_domain(io_domain_v1 *d) {
    atomic_flag_clear_explicit(&d->lock, memory_order_release);
}
static bool same(io_cookie_v1 a, io_cookie_v1 b) { return a.hi == b.hi && a.lo == b.lo; }
static bool nonzero(io_cookie_v1 a) { return a.hi != 0 || a.lo != 0; }
static io_status_v1 hold(io_domain_v1 *d) { d->held = true; return IO_HELD_V1; }
static io_status_v1 done(io_domain_v1 *d, io_status_v1 status) {
    unlock_domain(d); return status;
}
static unsigned bucket_mask(io_object_v1 object, io_direction_v1 direction) {
    if (direction != IO_READ_V1 && direction != IO_WRITE_V1) return 0;
    switch (object) {
    case IO_NULL_V1: return direction == IO_READ_V1 ? 1U : 2U;
    case IO_ZERO_V1: return direction == IO_READ_V1 ? 4U : 0U;
    case IO_URANDOM_V1: return direction == IO_READ_V1 ? 16U : 0U;
    case IO_STDOUT_V1: return direction == IO_WRITE_V1 ? 192U : 0U;
    case IO_STDERR_V1: return direction == IO_WRITE_V1 ? 128U : 0U;
    default: return 0;
    }
}
io_status_v1 io_init_v1(io_domain_v1 *d, const rp_policy_v1 *policy,
                       io_cookie_v1 domain, io_slot_v1 *slots, size_t capacity) {
    rp_limits_v1 limits;
    if (d == NULL) return IO_INVALID_V1;
    lock_domain(d);
    if (d->initialized) return done(d, hold(d));
    if (!nonzero(domain) || slots == NULL || capacity == 0 ||
        capacity > SIZE_MAX / sizeof(*slots) || !rp_get_limits_v1(policy, &limits))
        return done(d, IO_INVALID_V1);
    memset(slots, 0, capacity * sizeof(*slots));
    d->domain = domain; d->slots = slots; d->capacity = capacity;
    memcpy(d->caps, limits.io_caps, sizeof(d->caps));
    memset(d->used, 0, sizeof(d->used));
    d->high_operation_id = 0; d->held = false; d->initialized = true;
    return done(d, IO_ALLOWED_V1);
}
io_status_v1 io_reserve_v1(io_domain_v1 *d, const io_request_v1 *r, io_ticket_v1 *out) {
    size_t index; unsigned mask;
    if (out != NULL) memset(out, 0, sizeof(*out));
    if (d == NULL || r == NULL || out == NULL) return IO_INVALID_V1;
    lock_domain(d);
    if (!d->initialized) return done(d, IO_INVALID_V1);
    if (d->held) return done(d, IO_HELD_V1);
    if (!same(d->domain, r->domain) || !nonzero(r->task) || !nonzero(r->object) ||
        d->high_operation_id == UINT64_MAX || r->operation_id != d->high_operation_id + 1)
        return done(d, hold(d));
    d->high_operation_id = r->operation_id;
    mask = bucket_mask(r->object_class, r->direction);
    if (mask == 0) return done(d, IO_DENIED_V1);
    for (unsigned b = 0; b < 8; b++) {
        if ((mask & (1U << b)) != 0 &&
            (d->used[b] > d->caps[b] || r->requested > d->caps[b] - d->used[b]))
            return done(d, IO_DENIED_V1);
    }
    for (index = 0; index < d->capacity && d->slots[index].active; index++) { }
    if (index == d->capacity) return done(d, IO_DENIED_V1);
    io_slot_v1 *slot = &d->slots[index];
    if (slot->generation == UINT64_MAX) return done(d, hold(d));
    slot->generation++; slot->operation_id = r->operation_id;
    slot->task = r->task; slot->object = r->object;
    slot->reserved = r->requested; slot->mask = mask;
    slot->unknown = false; slot->active = true;
    for (unsigned b = 0; b < 8; b++) if ((mask & (1U << b)) != 0) d->used[b] += r->requested;
    out->domain = d->domain; out->task = r->task; out->object = r->object;
    out->operation_id = r->operation_id; out->generation = slot->generation; out->slot = index;
    return done(d, IO_ALLOWED_V1);
}
io_status_v1 io_complete_v1(io_domain_v1 *d, const io_ticket_v1 *t, bool known, uint64_t actual) {
    if (d == NULL || t == NULL) return IO_INVALID_V1;
    lock_domain(d);
    if (!d->initialized) return done(d, IO_INVALID_V1);
    if (!same(d->domain, t->domain) || t->slot >= d->capacity) return done(d, hold(d));
    io_slot_v1 *slot = &d->slots[t->slot];
    if (!slot->active || slot->operation_id != t->operation_id || slot->generation != t->generation ||
        !same(slot->task, t->task) || !same(slot->object, t->object)) return done(d, hold(d));
    if (slot->unknown) return done(d, IO_HELD_V1);
    if (!known) { slot->unknown = true; return done(d, hold(d)); }
    if (actual > slot->reserved) { slot->unknown = true; return done(d, hold(d)); }
    uint64_t unused = slot->reserved - actual;
    for (unsigned b = 0; b < 8; b++)
        if ((slot->mask & (1U << b)) != 0 && d->used[b] < unused) return done(d, hold(d));
    for (unsigned b = 0; b < 8; b++) if ((slot->mask & (1U << b)) != 0) d->used[b] -= unused;
    slot->active = false;
    return done(d, d->held ? IO_HELD_V1 : IO_ALLOWED_V1);
}
io_status_v1 io_snapshot_get_v1(io_domain_v1 *d, io_snapshot_v1 *out) {
    if (d == NULL || out == NULL) return IO_INVALID_V1;
    memset(out, 0, sizeof(*out)); lock_domain(d);
    if (!d->initialized) return done(d, IO_INVALID_V1);
    out->held = d->held; out->high_operation_id = d->high_operation_id;
    memcpy(out->used, d->used, sizeof(out->used));
    return done(d, d->held ? IO_HELD_V1 : IO_ALLOWED_V1);
}

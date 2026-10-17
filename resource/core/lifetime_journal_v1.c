#include "lifetime_journal_v1.h"
#include "lifetime_sink_v1.h"
#include <string.h>

#define ALL_LIFECYCLE_REPORTS 0x3fU
#define NO_BIRTH_REPORT 0x40U
_Static_assert(sizeof(size_t) <= sizeof(uint64_t), "slot index wire bound");
static bool same(lj_cookie_v1 a, lj_cookie_v1 b) { return a.hi == b.hi && a.lo == b.lo; }
static bool nonzero(lj_cookie_v1 a) { return a.hi != 0U || a.lo != 0U; }
static void lock(lj_domain_v1 *d) { while (atomic_flag_test_and_set_explicit(&d->lock, memory_order_acquire)) { } }
static void unlock(lj_domain_v1 *d) { atomic_flag_clear_explicit(&d->lock, memory_order_release); }
static bool context(lj_domain_v1 *d) {
    return d->self == d && d->initialized && d->slots != NULL && d->sink != NULL
        && d->capacity > 0U && d->capacity <= LJ_TASK_CAP_V1 && d->active <= d->capacity
        && atomic_load_explicit(&d->sink->bound_domain, memory_order_acquire) == (uintptr_t)d;
}
static lj_result_v1 held(lj_domain_v1 *d, lj_slot_v1 *s) {
    d->held = true;
    if (s != NULL) s->quarantined = true;
    return LJ_HELD_V1;
}
static bool ticket_equal(const lj_ticket_v1 *a, const lj_ticket_v1 *b) {
    return a->birth_id == b->birth_id && a->generation == b->generation && a->slot == b->slot
        && same(a->domain, b->domain) && same(a->task, b->task)
        && same(a->parent, b->parent) && same(a->tracer, b->tracer);
}
static lj_slot_v1 *lookup(lj_domain_v1 *d, const lj_ticket_v1 *t) {
    if (t == NULL || t->slot >= d->capacity || !same(t->domain, d->domain)) return NULL;
    lj_slot_v1 *s = &d->slots[t->slot];
    return s->active && ticket_equal(&s->ticket, t) ? s : NULL;
}
static void word(unsigned char *p, size_t at, uint64_t value) {
    for (size_t i = 0U; i < 8U; ++i) { p[at + 7U - i] = (unsigned char)(value & 255U); value >>= 8U; }
}
static void reservation_record(lj_slot_v1 *s, lj_cookie_v1 observer) {
    unsigned char *p = s->records;
    memset(p, 0, LJ_RECEIPT_BYTES_V1); memcpy(p, "LJRSRV01", 8U);
    word(p, 8U, LJ_RECORD_BYTES_V1); word(p, 16U, s->ticket.domain.hi); word(p, 24U, s->ticket.domain.lo);
    word(p, 32U, s->ticket.birth_id); word(p, 40U, s->ticket.generation); word(p, 48U, (uint64_t)s->ticket.slot);
    word(p, 56U, LJ_WAITABLE_EXEC_CHILD_V1); word(p, 64U, s->ticket.task.hi); word(p, 72U, s->ticket.task.lo);
    word(p, 80U, s->ticket.parent.hi); word(p, 88U, s->ticket.parent.lo);
    word(p, 96U, s->ticket.tracer.hi); word(p, 104U, s->ticket.tracer.lo);
    word(p, 112U, observer.hi); word(p, 120U, observer.lo);
    word(p, 128U, 1U); /* Component-only reported identities, never kernel credentials. */
}
static void terminal_record(lj_slot_v1 *s) {
    unsigned char *p = s->records + LJ_RECORD_BYTES_V1;
    memset(p, 0, LJ_RECORD_BYTES_V1); memcpy(p, "LJTERM01", 8U);
    word(p, 8U, LJ_RECORD_BYTES_V1); word(p, 16U, s->ticket.domain.hi); word(p, 24U, s->ticket.domain.lo);
    word(p, 32U, s->ticket.birth_id); word(p, 40U, s->ticket.generation); word(p, 48U, (uint64_t)s->ticket.slot);
    word(p, 56U, s->mask); word(p, 64U, s->ordinal);
    for (size_t i = 0U; i < 7U; ++i) word(p, 72U + i * 8U, s->event_sequence[i]);
    word(p, 128U, 1U);
}
lj_result_v1 lj_init_v1(lj_domain_v1 *d, lj_slot_v1 *slots, size_t capacity, size_t record_units,
                       lj_cookie_v1 domain, lj_cookie_v1 observer, lj_sink_v1 *sink) {
    if (d == NULL) return LJ_HELD_V1;
    lock(d);
    lj_result_v1 result = LJ_HELD_V1;
    if (d->initialized || d->self != NULL) { (void)held(d, NULL); goto finish; }
    d->self = d; d->initialized = true;
    if (slots == NULL || capacity == 0U || capacity > LJ_TASK_CAP_V1 || record_units != 2U * capacity
        || !nonzero(domain) || !nonzero(observer) || sink == NULL || sink->self != sink
        || !atomic_load_explicit(&sink->ready, memory_order_acquire)
        || atomic_load_explicit(&sink->held, memory_order_acquire) || !same(domain, sink->domain)) {
        (void)held(d, NULL); goto finish;
    }
    d->domain = domain; d->observer = observer; d->sink = sink; d->slots = slots; d->capacity = capacity;
    uintptr_t unbound = 0U;
    if (!atomic_compare_exchange_strong_explicit(&sink->bound_domain, &unbound, (uintptr_t)d,
                                                 memory_order_acq_rel, memory_order_acquire)) {
        (void)held(d, NULL); goto finish;
    }
    d->active = 0U; d->birth_id = 0U; d->flush_sequence = 0U;
    memset(slots, 0, capacity * sizeof(*slots)); result = LJ_OK_V1;
finish:
    unlock(d); return result;
}
lj_result_v1 lj_reserve_v1(lj_domain_v1 *d, lj_kind_v1 kind, lj_cookie_v1 task,
                          lj_cookie_v1 parent, lj_cookie_v1 tracer, lj_ticket_v1 *out) {
    if (d == NULL) return LJ_HELD_V1;
    if (out != NULL) memset(out, 0, sizeof(*out));
    lock(d); lj_result_v1 result = LJ_HELD_V1;
    if (!context(d) || out == NULL) { (void)held(d, NULL); goto finish; }
    if (d->held) goto finish;
    if (d->inflight) { result = LJ_BUSY_V1; goto finish; }
    if (kind != LJ_WAITABLE_EXEC_CHILD_V1 || !nonzero(task) || !nonzero(parent) || !nonzero(tracer)
        || !atomic_load_explicit(&d->sink->ready, memory_order_acquire)
        || atomic_load_explicit(&d->sink->held, memory_order_acquire)) { (void)held(d, NULL); goto finish; }
    for (size_t i = 0U; i < d->capacity; ++i) {
        if (d->slots[i].active && same(d->slots[i].ticket.task, task)) { (void)held(d, NULL); goto finish; }
    }
    if (d->active == d->capacity) { result = LJ_DENIED_V1; goto finish; }
    if (d->birth_id == UINT64_MAX || d->sink->sequence != d->flush_sequence
        || UINT64_MAX - d->flush_sequence <= (uint64_t)d->active
        || d->sink->bytes > (uint64_t)INT64_MAX
        || ((uint64_t)INT64_MAX - d->sink->bytes) / LJ_RECEIPT_BYTES_V1 <= (uint64_t)d->active) {
        (void)held(d, NULL); goto finish;
    }
    for (size_t i = 0U; i < d->capacity; ++i) if (!d->slots[i].active) {
        lj_slot_v1 *s = &d->slots[i];
        if (s->generation == UINT64_MAX) { (void)held(d, NULL); goto finish; }
        s->generation++; s->ordinal = 0U; s->mask = 0U; s->active = true;
        s->quarantined = false; s->flushing = false; memset(s->event_sequence, 0, sizeof(s->event_sequence));
        d->birth_id++; d->active++;
        s->ticket = (lj_ticket_v1){ d->domain, task, parent, tracer, d->birth_id, s->generation, i };
        reservation_record(s, d->observer); *out = s->ticket; result = LJ_OK_V1; break;
    }
finish:
    unlock(d); return result;
}
lj_result_v1 lj_report_v1(lj_domain_v1 *d, const lj_ticket_v1 *t, lj_event_v1 event,
                         uint64_t ordinal, lj_cookie_v1 reporter) {
    if (d == NULL) return LJ_HELD_V1;
    lock(d); lj_result_v1 result = LJ_HELD_V1; lj_slot_v1 *s = NULL;
    if (!context(d) || (s = lookup(d, t)) == NULL) { (void)held(d, NULL); goto finish; }
    if (s->quarantined || s->flushing || (s->mask & NO_BIRTH_REPORT) != 0U
        || s->ordinal == UINT64_MAX || ordinal != s->ordinal + 1U
        || (unsigned)event > (unsigned)LJ_NO_BIRTH_V1) { (void)held(d, s); goto finish; }
    const unsigned bit = 1U << (unsigned)event;
    const lj_cookie_v1 actor = event == LJ_TRACER_WAIT_V1 ? t->tracer
        : event == LJ_REAL_PARENT_REAP_V1 ? t->parent : d->observer;
    bool ordered = false;
    if (event == LJ_NO_BIRTH_V1) ordered = s->ordinal == 0U;
    else if (event <= LJ_EXIT_V1) ordered = s->ordinal == (uint64_t)event;
    else ordered = (s->mask & (1U << LJ_EXIT_V1)) != 0U && (s->mask & NO_BIRTH_REPORT) == 0U;
    if (!ordered || (s->mask & bit) != 0U || !same(reporter, actor)) { (void)held(d, s); goto finish; }
    s->mask |= bit; s->ordinal = ordinal; s->event_sequence[(size_t)event] = ordinal; result = LJ_OK_V1;
finish:
    unlock(d); return result;
}
lj_result_v1 lj_unknown_v1(lj_domain_v1 *d, const lj_ticket_v1 *t) {
    if (d == NULL) return LJ_HELD_V1;
    lock(d); lj_slot_v1 *s = context(d) ? lookup(d, t) : NULL;
    const lj_result_v1 result = held(d, s); unlock(d); return result;
}
lj_result_v1 lj_flush_v1(lj_domain_v1 *d, const lj_ticket_v1 *t) {
    if (d == NULL) return LJ_HELD_V1;
    lock(d); lj_slot_v1 *s = NULL;
    if (!context(d) || (s = lookup(d, t)) == NULL) { const lj_result_v1 r = held(d, NULL); unlock(d); return r; }
    if (d->inflight || s->quarantined || s->flushing || d->flush_sequence == UINT64_MAX
        || (s->mask != ALL_LIFECYCLE_REPORTS && s->mask != NO_BIRTH_REPORT)) {
        const lj_result_v1 r = held(d, s); unlock(d); return r;
    }
    d->flush_sequence++; const uint64_t sequence = d->flush_sequence;
    d->inflight = true; d->inflight_birth = t->birth_id; s->flushing = true;
    terminal_record(s);
    /* Bytes pinned in caller storage until commit. Other APIs cannot mutate/reuse them. */
    const unsigned char *record = s->records;
    lj_sink_v1 *sink = d->sink; const lj_cookie_v1 domain = d->domain;
    unlock(d);
    const lj_result_v1 io = lj_sink_append_internal_v1(sink, domain, sequence, record);
    lock(d);
    s = context(d) ? lookup(d, t) : NULL;
    lj_result_v1 result = LJ_HELD_V1;
    if (s != NULL && s->flushing && !s->quarantined && d->inflight
        && d->inflight_birth == t->birth_id && d->active > 0U && io == LJ_OK_V1) {
        s->active = false; s->flushing = false; d->active--; result = LJ_OK_V1;
    } else (void)held(d, s);
    d->inflight = false; unlock(d); return result;
}
lj_snapshot_v1 lj_snapshot_v1_get(lj_domain_v1 *d) {
    lj_snapshot_v1 result = {0U, 0U, true, false, false};
    if (d == NULL) return result;
    lock(d);
    if (context(d)) result = (lj_snapshot_v1){ d->active, d->active * 2U, d->held, d->inflight, false };
    unlock(d); return result;
}

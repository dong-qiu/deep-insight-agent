#include "../core/io_budget_v1.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define M UINT64_C(1048576)
static const rp_policy_v1 *policy;
static uint64_t domain_sequence;
static unsigned checks;
static void check(int value, const char *text, int line) {
    checks++;
    if (!value) { fprintf(stderr, "FAIL line%d: %s\n", line, text); exit(EXIT_FAILURE); }
}
#define CHECK(x) check((x), #x, __LINE__)
static void init(io_domain_v1 *d, io_slot_v1 *slots, size_t capacity) {
    io_cookie_v1 cookie = { 77, ++domain_sequence };
    CHECK(io_init_v1(d, policy, cookie, slots, capacity) == IO_ALLOWED_V1);
}
static io_request_v1 request(io_domain_v1 *d, uint64_t id, io_object_v1 object,
                             io_direction_v1 direction, uint64_t bytes) {
    io_request_v1 r = { d->domain, {2,3}, {4,5}, id, object, direction, bytes };
    return r;
}
static io_snapshot_v1 snapshot(io_domain_v1 *d) {
    io_snapshot_v1 s;
    io_status_v1 rc = io_snapshot_get_v1(d, &s);
    CHECK(rc == IO_ALLOWED_V1 || rc == IO_HELD_V1);
    return s;
}
static void policy_roundtrip(void) {
    uint8_t wire[8192]; rp_limits_v1 l;
    CHECK(rp_wire_size_v1() == 3107);
    CHECK(rp_write_wire_v1(wire, sizeof(wire)));
    CHECK(memcmp(wire, "IARC0001", 8) == 0);
    CHECK(wire[8] == 0 && wire[11] == 1 && wire[12] == 0 && wire[13] == 0 && wire[14] == 12 && wire[15] == 35);
    CHECK(strlen(rp_payload_v1()) == 3083);
    CHECK(strcmp(rp_payload_sha256_v1(), "22b76496adbaf6aa6738a45d368c8d94148b08492f4115929eeb879bfe9836d4") == 0);
    CHECK(strstr(rp_payload_v1(), "e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174") != NULL);
    CHECK(strstr(rp_payload_v1(), "622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24") != NULL);
    CHECK(strstr(rp_payload_v1(), "92a1ab9526bcf48e269837871fdf1c4c3405ce66d06d01441cccb963dd8ffdfb") != NULL);
    CHECK(strstr(rp_payload_v1(), "64fb149678cbcef8cbadc9df98caf4af04f46c16fe3bd30cd0800e8a565d285e") != NULL);
    CHECK(strstr(rp_payload_v1(), "b347111880c8ddc3cf60e63fa56561cfa6407282645d05a3574104cccba73c57") != NULL);
    CHECK(rp_decode_v1(wire, rp_wire_size_v1(), &policy));
    CHECK(rp_get_limits_v1(policy, &l));
    CHECK(l.scratch_bytes == 67108864 && l.memory_max == 268435456 && l.swap_max == 0 && l.pids_max == 16);
    CHECK(l.child_seconds == 120 && l.grace_seconds == 2 && l.batch_seconds == 1200);
    CHECK(l.descriptor_bytes == M && l.diagnostic_bytes == 2*M && l.control_frame_bytes == 4096 && l.control_silence_seconds == 30);
    const uint64_t caps[8] = {M,M,M,0,M,0,M,2*M};
    CHECK(memcmp(caps, l.io_caps, sizeof(caps)) == 0);
}
static void policy_lengths(void) {
    uint8_t wire[8192]; const rp_policy_v1 *p = policy;
    CHECK(!rp_write_wire_v1(NULL, 8192));
    CHECK(!rp_write_wire_v1(wire, rp_wire_size_v1()-1));
    CHECK(rp_write_wire_v1(wire, sizeof(wire)));
    CHECK(!rp_decode_v1(NULL, rp_wire_size_v1(), &p) && p == NULL);
    CHECK(!rp_decode_v1(wire, rp_wire_size_v1(), NULL));
    for (size_t n = 0; n < rp_wire_size_v1(); n++) CHECK(!rp_decode_v1(wire, n, &p) && p == NULL);
    CHECK(!rp_decode_v1(wire, rp_wire_size_v1()+1, &p));
}
static void policy_every_byte(void) {
    uint8_t wire[8192]; const rp_policy_v1 *p;
    CHECK(rp_write_wire_v1(wire, sizeof(wire)));
    for (size_t i = 0; i < rp_wire_size_v1(); i++) {
        wire[i] ^= 1; CHECK(!rp_decode_v1(wire, rp_wire_size_v1(), &p) && p == NULL); wire[i] ^= 1;
    }
}
static void reject_replacement(const char *needle, const char *replacement) {
    uint8_t wire[8192]; const rp_policy_v1 *p; const char *raw = rp_payload_v1();
    const char *where = strstr(raw, needle); CHECK(where != NULL);
    size_t prefix = (size_t)(where-raw), old = strlen(needle), add = strlen(replacement);
    size_t tail = strlen(raw)-prefix-old, total = 24+prefix+add+tail;
    CHECK(total < sizeof(wire)); CHECK(rp_write_wire_v1(wire, sizeof(wire)));
    memcpy(wire+24+prefix, replacement, add); memcpy(wire+24+prefix+add, where+old, tail);
    uint32_t value = (uint32_t)total;
    for (unsigned i=0;i<4;i++) wire[12+i]=(uint8_t)(value>>(24U-i*8U));
    CHECK(!rp_decode_v1(wire,total,&p) && p==NULL);
}
static void policy_malformed(void) {
    reject_replacement("\"memoryMax\":268435456", "\"memoryMax\":268435457");
    reject_replacement("\"memoryMax\":268435456", "\"memoryMax\":null");
    reject_replacement("\"memoryMax\":268435456", "\"memoryMax\":268435456.0");
    reject_replacement("\"memoryMax\":268435456", "\"memoryMax\":18446744073709551616");
    reject_replacement("\"memoryMax\":268435456", "\"memoryMax\":268435456,\"memoryMax\":1");
    reject_replacement("\"memoryMax\":268435456,", "");
    reject_replacement("{", "{\"unknown\":0,");
    reject_replacement("{", "{ ");
}
static void policy_identity(void) {
    rp_limits_v1 l; unsigned char fake[16] = {0};
    CHECK(!rp_get_limits_v1(NULL,&l) && l.memory_max == 0);
    CHECK(!rp_get_limits_v1((const rp_policy_v1 *)(const void *)fake,&l));
    CHECK(!rp_get_limits_v1(policy,NULL));
}
static void cap_boundaries(void) {
    const io_object_v1 objects[] = {IO_NULL_V1,IO_NULL_V1,IO_ZERO_V1,IO_URANDOM_V1,IO_STDOUT_V1,IO_STDERR_V1};
    const io_direction_v1 directions[] = {IO_READ_V1,IO_WRITE_V1,IO_READ_V1,IO_READ_V1,IO_WRITE_V1,IO_WRITE_V1};
    for (size_t i=0;i<6;i++) {
        io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER; io_slot_v1 slots[2]; io_ticket_v1 t;
        init(&d,slots,2); uint64_t cap=objects[i]==IO_STDERR_V1?2*M:M;
        io_request_v1 r=request(&d,1,objects[i],directions[i],cap-1);
        CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1); CHECK(io_complete_v1(&d,&t,true,cap-1)==IO_ALLOWED_V1);
        r.operation_id=2;r.requested=1;CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);CHECK(io_complete_v1(&d,&t,true,1)==IO_ALLOWED_V1);
        r.operation_id=3;CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(!snapshot(&d).held);
    }
}
static void oversized_and_directions(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,UINT64_MAX);
    CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(snapshot(&d).used[0]==0);
    r=request(&d,2,IO_ZERO_V1,IO_WRITE_V1,0);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,3,IO_URANDOM_V1,IO_WRITE_V1,1);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,4,IO_STDOUT_V1,IO_READ_V1,0);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,5,(io_object_v1)99,IO_WRITE_V1,1);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,6,IO_NULL_V1,(io_direction_v1)99,1);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,7,IO_NULL_V1,IO_READ_V1,M+1);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    r=request(&d,8,IO_NULL_V1,IO_READ_V1,M);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
}
static void multi_bucket(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 t;init(&d,slots,2);
    io_request_v1 r=request(&d,1,IO_STDERR_V1,IO_WRITE_V1,M+100);
    CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);CHECK(io_complete_v1(&d,&t,true,M+100)==IO_ALLOWED_V1);
    r=request(&d,2,IO_STDOUT_V1,IO_WRITE_V1,M);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);
    io_snapshot_v1 s=snapshot(&d);CHECK(s.used[6]==0 && s.used[7]==M+100);
    r.operation_id=3;r.requested=M-100;CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    s=snapshot(&d);CHECK(s.used[6]==M-100 && s.used[7]==2*M);
}
static void short_completion(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&t,true,25)==IO_ALLOWED_V1);io_snapshot_v1 s=snapshot(&d);CHECK(s.used[6]==25 && s.used[7]==25);
    r.operation_id=2;r.requested=M-25;CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);CHECK(t.generation==2);
    CHECK(io_complete_v1(&d,&t,true,M-25)==IO_ALLOWED_V1);CHECK(snapshot(&d).used[6]==M);
}
static void unknown_no_refund(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t,u;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&t,false,UINT64_MAX)==IO_HELD_V1);CHECK(io_complete_v1(&d,&t,true,0)==IO_HELD_V1);
    r.operation_id=2;CHECK(io_reserve_v1(&d,&r,&u)==IO_HELD_V1);io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[6]==100 && s.used[7]==100);
}
static void wrong_tickets(void) {
    for (unsigned kind=0;kind<6;kind++) {
        io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
        io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
        switch(kind) {case 0:t.domain.lo++;break;case 1:t.task.lo++;break;case 2:t.object.lo++;break;case 3:t.operation_id++;break;case 4:t.generation++;break;default:t.slot=1;break;}
        CHECK(io_complete_v1(&d,&t,true,0)==IO_HELD_V1);io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[6]==100 && s.used[7]==100);
    }
}
static void duplicate_completion(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&t,true,50)==IO_ALLOWED_V1);CHECK(io_complete_v1(&d,&t,true,0)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==50);
}
static void duplicate_reservation(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 t,u;init(&d,slots,2);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_reserve_v1(&d,&r,&u)==IO_HELD_V1);CHECK(u.generation==0 && u.domain.hi==0);CHECK(snapshot(&d).used[6]==100);
}
static void storage_reuse_stale(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 old,t;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&old)==IO_ALLOWED_V1);
    r.operation_id=2;r.requested=5;CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(snapshot(&d).used[6]==100);
    CHECK(io_complete_v1(&d,&old,true,25)==IO_ALLOWED_V1);r.operation_id=3;r.requested=100;CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);CHECK(t.generation==2);
    CHECK(io_complete_v1(&d,&old,true,0)==IO_HELD_V1);CHECK(snapshot(&d).used[6]==125);CHECK(io_complete_v1(&d,&t,true,100)==IO_HELD_V1);
}
static void inconsistent_actual(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&t,true,101)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==100);
}
static void known_cleanup_held(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 a,b;init(&d,slots,2);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&a)==IO_ALLOWED_V1);
    r=request(&d,2,IO_STDERR_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&b)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&a,false,0)==IO_HELD_V1);CHECK(io_complete_v1(&d,&b,true,25)==IO_HELD_V1);io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[6]==100 && s.used[7]==125);
}
static void init_and_invalid(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;io_snapshot_v1 s;io_cookie_v1 zero={0,0};
    CHECK(io_init_v1(NULL,policy,zero,slots,1)==IO_INVALID_V1);CHECK(io_init_v1(&d,policy,zero,slots,1)==IO_INVALID_V1);
    CHECK(io_snapshot_get_v1(&d,&s)==IO_INVALID_V1);CHECK(io_init_v1(&d,NULL,(io_cookie_v1){1,1},slots,1)==IO_INVALID_V1);
    CHECK(io_init_v1(&d,policy,(io_cookie_v1){1,1},NULL,1)==IO_INVALID_V1);CHECK(io_init_v1(&d,policy,(io_cookie_v1){1,1},slots,0)==IO_INVALID_V1);
    CHECK(io_init_v1(&d,policy,(io_cookie_v1){1,1},slots,SIZE_MAX)==IO_INVALID_V1);init(&d,slots,1);
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    CHECK(io_init_v1(&d,policy,(io_cookie_v1){2,2},slots,1)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==100);
    CHECK(io_reserve_v1(NULL,&r,&t)==IO_INVALID_V1);CHECK(io_reserve_v1(&d,NULL,&t)==IO_INVALID_V1);CHECK(io_reserve_v1(&d,&r,NULL)==IO_INVALID_V1);
    CHECK(io_complete_v1(NULL,&t,true,0)==IO_INVALID_V1);CHECK(io_complete_v1(&d,NULL,true,0)==IO_INVALID_V1);CHECK(io_snapshot_get_v1(&d,NULL)==IO_INVALID_V1);
}
static void invalid_requests(void) {
    for (unsigned kind=0;kind<4;kind++) {
        io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);
        io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,100);
        switch(kind){case 0:r.domain.lo++;break;case 1:r.task=(io_cookie_v1){0,0};break;case 2:r.object=(io_cookie_v1){0,0};break;default:r.operation_id=0;break;}
        CHECK(io_reserve_v1(&d,&r,&t)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==0);
    }
}
static void identity_generation_wrap(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[1];io_ticket_v1 t;init(&d,slots,1);slots[0].generation=UINT64_MAX;
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,1);CHECK(io_reserve_v1(&d,&r,&t)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==0);
    /* Seed the TCB counter boundary; do not claim2^64 real preceding attempts. */
    io_domain_v1 e=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 other[1];init(&e,other,1);e.high_operation_id=UINT64_MAX-1;r=request(&e,UINT64_MAX,IO_NULL_V1,IO_READ_V1,0);CHECK(io_reserve_v1(&e,&r,&t)==IO_ALLOWED_V1);CHECK(io_complete_v1(&e,&t,true,0)==IO_ALLOWED_V1);
    r.operation_id=1;CHECK(io_reserve_v1(&e,&r,&t)==IO_HELD_V1);CHECK(snapshot(&e).used[0]==0);
}
static void cross_domain(void) {
    io_domain_v1 a=IO_DOMAIN_V1_INITIALIZER,b=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 as[1],bs[1];io_ticket_v1 ta,tb;init(&a,as,1);init(&b,bs,1);
    io_request_v1 ra=request(&a,1,IO_NULL_V1,IO_READ_V1,50),rb=request(&b,1,IO_NULL_V1,IO_READ_V1,50);
    CHECK(io_reserve_v1(&a,&ra,&ta)==IO_ALLOWED_V1);CHECK(io_reserve_v1(&b,&rb,&tb)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&b,&ta,true,0)==IO_HELD_V1);CHECK(snapshot(&b).used[0]==50);CHECK(io_complete_v1(&a,&ta,true,50)==IO_ALLOWED_V1);
}
typedef struct { io_domain_v1 *domain;uint64_t id;atomic_uint *ready;atomic_bool *go;io_status_v1 status;io_ticket_v1 ticket;pthread_mutex_t *delivery;uint64_t *next; } writer_args;
static void *writer(void *arg) {
    writer_args *a=arg;
    atomic_fetch_add_explicit(a->ready,1,memory_order_release);
    while(!atomic_load_explicit(a->go,memory_order_acquire)) { }
    uint64_t id=a->id;
    if(a->delivery!=NULL) {
        if(pthread_mutex_lock(a->delivery)!=0){a->status=IO_INVALID_V1;return NULL;}
        id=++*a->next;
    }
    io_request_v1 r=request(a->domain,id,IO_STDOUT_V1,IO_WRITE_V1,M);
    a->status=io_reserve_v1(a->domain,&r,&a->ticket);
    if(a->delivery!=NULL && pthread_mutex_unlock(a->delivery)!=0)a->status=IO_INVALID_V1;
    return NULL;
}
static void two_writers(void) {
    for (unsigned round=0;round<32;round++) {
        io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];init(&d,slots,2);atomic_uint ready=0;atomic_bool go=false;
        /* Trusted adapter must serialize BOTH issuance and delivery, per contract. */
        pthread_mutex_t delivery=PTHREAD_MUTEX_INITIALIZER;uint64_t next=0;
        writer_args args[2]={{.domain=&d,.ready=&ready,.go=&go,.delivery=&delivery,.next=&next},{.domain=&d,.ready=&ready,.go=&go,.delivery=&delivery,.next=&next}};pthread_t threads[2];
        CHECK(pthread_create(&threads[0],NULL,writer,&args[0])==0);CHECK(pthread_create(&threads[1],NULL,writer,&args[1])==0);
        while(atomic_load_explicit(&ready,memory_order_acquire)!=2) { }
        atomic_store_explicit(&go,true,memory_order_release);
        CHECK(pthread_join(threads[0],NULL)==0);CHECK(pthread_join(threads[1],NULL)==0);
        CHECK(pthread_mutex_destroy(&delivery)==0);
        unsigned allowed=(args[0].status==IO_ALLOWED_V1?1U:0U)+(args[1].status==IO_ALLOWED_V1?1U:0U);CHECK(allowed==1);
        CHECK((args[0].status==IO_ALLOWED_V1 || args[0].status==IO_HELD_V1 || args[0].status==IO_DENIED_V1) && (args[1].status==IO_ALLOWED_V1 || args[1].status==IO_HELD_V1 || args[1].status==IO_DENIED_V1));
        io_snapshot_v1 s=snapshot(&d);CHECK(!s.held && s.used[6]==M && s.used[7]==M && s.high_operation_id==2);
    }
}
static void two_duplicate_writers(void) {
    for(unsigned round=0;round<32;round++) {
        io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];init(&d,slots,2);atomic_uint ready=0;atomic_bool go=false;
        writer_args args[2]={{.domain=&d,.id=1,.ready=&ready,.go=&go},{.domain=&d,.id=1,.ready=&ready,.go=&go}};pthread_t threads[2];
        CHECK(pthread_create(&threads[0],NULL,writer,&args[0])==0);CHECK(pthread_create(&threads[1],NULL,writer,&args[1])==0);
        while(atomic_load_explicit(&ready,memory_order_acquire)!=2) { }
        atomic_store_explicit(&go,true,memory_order_release);
        CHECK(pthread_join(threads[0],NULL)==0);CHECK(pthread_join(threads[1],NULL)==0);
        CHECK((args[0].status==IO_ALLOWED_V1 && args[1].status==IO_HELD_V1)||(args[1].status==IO_ALLOWED_V1 && args[0].status==IO_HELD_V1));
        io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[6]==M && s.used[7]==M && s.high_operation_id==1);
    }
}
static void sequence_attempt_boundaries(void) {
    io_domain_v1 gap=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 gs[1];io_ticket_v1 t;init(&gap,gs,1);
    io_request_v1 r=request(&gap,2,IO_NULL_V1,IO_READ_V1,1);CHECK(io_reserve_v1(&gap,&r,&t)==IO_HELD_V1);CHECK(snapshot(&gap).used[0]==0 && !gs[0].active);
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 a,b;init(&d,slots,2);
    r=request(&d,1,IO_NULL_V1,IO_READ_V1,UINT64_MAX);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(snapshot(&d).high_operation_id==1 && !slots[0].active);
    r=request(&d,2,IO_NULL_V1,IO_READ_V1,1);CHECK(io_reserve_v1(&d,&r,&a)==IO_ALLOWED_V1);
    r=request(&d,3,IO_ZERO_V1,IO_WRITE_V1,0);CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(snapshot(&d).high_operation_id==3);
    r=request(&d,4,IO_NULL_V1,IO_READ_V1,1);CHECK(io_reserve_v1(&d,&r,&b)==IO_ALLOWED_V1);
    r.operation_id=5;CHECK(io_reserve_v1(&d,&r,&t)==IO_DENIED_V1);CHECK(snapshot(&d).high_operation_id==5 && snapshot(&d).used[0]==2);
    /* Reverse ticket completion is legal; request issuance sequence is separate. */
    CHECK(io_complete_v1(&d,&b,true,1)==IO_ALLOWED_V1);CHECK(io_complete_v1(&d,&a,true,1)==IO_ALLOWED_V1);
    r.operation_id=6;CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    r.operation_id=8;CHECK(io_reserve_v1(&d,&r,&t)==IO_HELD_V1);CHECK(snapshot(&d).used[0]==3);
}
typedef void (*test_fn)(void);
static void sequence_gap_regression(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 t;init(&d,slots,2);
    io_request_v1 r=request(&d,1,IO_NULL_V1,IO_READ_V1,100);CHECK(io_reserve_v1(&d,&r,&t)==IO_ALLOWED_V1);
    r.operation_id=3;CHECK(io_reserve_v1(&d,&r,&t)==IO_HELD_V1);
    io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[0]==100);
}
static void poison_same_ticket_regression(void) {
    io_domain_v1 d=IO_DOMAIN_V1_INITIALIZER;io_slot_v1 slots[2];io_ticket_v1 a,b;init(&d,slots,2);
    io_request_v1 r=request(&d,1,IO_STDOUT_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&a)==IO_ALLOWED_V1);
    r=request(&d,2,IO_STDERR_V1,IO_WRITE_V1,100);CHECK(io_reserve_v1(&d,&r,&b)==IO_ALLOWED_V1);
    CHECK(io_complete_v1(&d,&a,true,101)==IO_HELD_V1);
    CHECK(io_complete_v1(&d,&a,true,0)==IO_HELD_V1);
    io_snapshot_v1 s=snapshot(&d);CHECK(s.held && s.used[6]==100 && s.used[7]==200);
    CHECK(slots[a.slot].active && slots[a.slot].unknown);
    CHECK(io_complete_v1(&d,&b,true,25)==IO_HELD_V1);
    s=snapshot(&d);CHECK(s.used[6]==100 && s.used[7]==125);
    CHECK(io_complete_v1(&d,&a,true,0)==IO_HELD_V1);CHECK(snapshot(&d).used[7]==125);
}
int main(int argc, char **argv) {
    const struct {const char *id;test_fn run;} cases[]={
        {"policy_roundtrip",policy_roundtrip},{"policy_lengths",policy_lengths},{"policy_every_byte",policy_every_byte},{"policy_malformed",policy_malformed},{"policy_identity",policy_identity},
        {"cap_boundaries",cap_boundaries},{"oversized_and_directions",oversized_and_directions},{"multi_bucket",multi_bucket},{"short_completion",short_completion},{"unknown_no_refund",unknown_no_refund},
        {"wrong_tickets",wrong_tickets},{"duplicate_completion",duplicate_completion},{"duplicate_reservation",duplicate_reservation},{"storage_reuse_stale",storage_reuse_stale},{"inconsistent_actual",inconsistent_actual},
        {"known_cleanup_held",known_cleanup_held},{"init_and_invalid",init_and_invalid},{"invalid_requests",invalid_requests},{"identity_generation_wrap",identity_generation_wrap},{"cross_domain",cross_domain},{"two_writers",two_writers},
        {"sequence_gap_regression",sequence_gap_regression},{"poison_same_ticket_regression",poison_same_ticket_regression},
        {"sequence_attempt_boundaries",sequence_attempt_boundaries},{"two_duplicate_writers",two_duplicate_writers}
    };
    if(argc==2) {
        policy_roundtrip();
        for(size_t i=0;i<sizeof(cases)/sizeof(cases[0]);i++) if(strcmp(argv[1],cases[i].id)==0) {
            cases[i].run();printf("PASS selected=%s checks=%u qualification=false\n",cases[i].id,checks);return 0;
        }
        fprintf(stderr,"Unknown fixed test selector\n");return 2;
    }
    if(argc!=1) return 2;
    for(size_t i=0;i<sizeof(cases)/sizeof(cases[0]);i++){cases[i].run();printf("PASS %s\n",cases[i].id);}
    printf("PASS groups=%zu checks=%u ordered_writer_rounds=32 duplicate_writer_rounds=32 maximum_workers=2 qualification=false\n",sizeof(cases)/sizeof(cases[0]),checks);return 0;
}

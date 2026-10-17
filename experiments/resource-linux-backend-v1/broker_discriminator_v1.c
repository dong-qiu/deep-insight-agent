#define _GNU_SOURCE
/* P31 engineering fixture only. Not an executor or original qualification. */
#ifndef __linux__
#error P31 requires actual Linux
#endif
#include "io_budget_v1.h"
#include "lifetime_journal_v1.h"
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#ifndef P31_NEGATIVE_CONTROL
#define P31_NEGATIVE_CONTROL 0
#endif
#define CHUNK 4096U
_Static_assert(ATOMIC_INT_LOCK_FREE == 2, "shared fixture needs lock-free atomics");
#define OUT_CAP 1048576U
#define BOTH_CAP 2097152U
#define X32_BIT 0x40000000U
#define DENY (SECCOMP_RET_ERRNO | EPERM)
#define ARRAY_LEN(a) (sizeof(a) / sizeof((a)[0]))
#define INS(code, jt, jf, k) { (unsigned short)(code), (jt), (jf), (k) }
#define ST(code, k) INS(code, 0, 0, k)
#define JEQ(k, jt, jf) INS(BPF_JMP | BPF_JEQ | BPF_K, jt, jf, k)
/* Original notification layer: only fixed fixture FD writes. Parent guard >=200. */
static const struct sock_filter notify_filter[] = {
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
 JEQ(AUDIT_ARCH_X86_64, 1, 0), ST(BPF_RET|BPF_K, DENY),
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
 INS(BPF_JMP|BPF_JSET|BPF_K, 0, 1, X32_BIT), ST(BPF_RET|BPF_K, DENY),
 JEQ(SYS_write, 1, 0), JEQ(SYS_writev, 0, 5),
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
 JEQ(1, 2, 0), JEQ(2, 1, 0), JEQ(103, 0, 1),
 ST(BPF_RET|BPF_K, SECCOMP_RET_USER_NOTIF),
 ST(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
};
/* Only raw fixture operations. No rebind, opens, clone/exec, filter stacking. */
#define ALLOW_NR(n) JEQ(n, 0, 1), ST(BPF_RET|BPF_K, SECCOMP_RET_ALLOW)
static const struct sock_filter strict_filter[] = {
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
 JEQ(AUDIT_ARCH_X86_64, 1, 0), ST(BPF_RET|BPF_K, DENY),
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
 ALLOW_NR(SYS_exit), ALLOW_NR(SYS_exit_group), ALLOW_NR(SYS_rt_sigreturn),
 ALLOW_NR(SYS_sched_yield), ALLOW_NR(SYS_futex),
 /* write/writev still pass through inherited FD-specific notification layer. */
 JEQ(SYS_write, 1, 0), JEQ(SYS_writev, 0, 5),
 ST(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
 JEQ(1, 2, 0), JEQ(2, 1, 0), JEQ(103, 0, 1),
 ST(BPF_RET|BPF_K, SECCOMP_RET_ALLOW), ST(BPF_RET|BPF_K, DENY)
};
struct shared {
 atomic_int ready[2], go, phase, errors, denied, ok, mutator_tid;
 struct iovec iov;
 char data[2];
};
struct broker {
 io_domain_v1 *domain;
 uint64_t operation, actual, observed[2], hashes[2], prefill, partial;
 unsigned allowed, denied, notifications, send_failed;
 int adapter_hold, outfd, errfd, rd[2], listener;
 pid_t children[2], born[2];
 uint64_t first_id, last_id; uint32_t first_task, last_task;
 struct stat pipe_identity[2];
 int workers;
};
static int report_fd = -1, diagnostic_fd = -1;
static void fail(const char *what) {
 int e = errno;
 if (diagnostic_fd >= 0) dprintf(diagnostic_fd, "P31 FAIL %s errno=%d (%s)\n", what, e, strerror(e));
 _exit(90);
}
#define REQUIRE(x, m) do { if (!(x)) fail(m); } while (0)
static int guard_dup(int fd) {
 int g = fcntl(fd, F_DUPFD_CLOEXEC, 200);
 REQUIRE(g >= 200, "guard dup"); return g;
}
static void strict_copy(struct sock_filter *out, int race) {
 memcpy(out, strict_filter, sizeof(strict_filter));
 if (!race) for (size_t i = 0; i < ARRAY_LEN(strict_filter); i++)
  if (out[i].code == (BPF_JMP|BPF_JEQ|BPF_K) && out[i].k == SYS_writev) out[i].k = SYS_write;
}
static void describe(void) {
 struct sock_filter write_only[ARRAY_LEN(strict_filter)]; strict_copy(write_only, 0);
 const struct sock_filter *sets[] = {notify_filter, strict_filter, write_only};
 const size_t sizes[] = {sizeof(notify_filter), sizeof(strict_filter), sizeof(write_only)};
 printf("{\"schema\":\"p31-compiled-filter-v1\",\"negative_build\":%d,\"filters\":[", P31_NEGATIVE_CONTROL);
 for (size_t n = 0; n < ARRAY_LEN(sets); n++) {
  const unsigned char *p = (const unsigned char *)sets[n];
  printf("%s\"", n ? "," : "");
  for (size_t k = 0; k < sizes[n]; k++) printf("%02x", p[k]);
  printf("\"");
 }
 printf("],\"scope\":\"own-process-classic-seccomp-only\",\"qualification\":false}\n");
}
static void install_strict(int threads) {
 struct sock_filter selected[ARRAY_LEN(strict_filter)]; strict_copy(selected, threads);
 struct sock_fprog p = {.len = (unsigned short)ARRAY_LEN(selected), .filter = selected};
 long r = syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, threads ? SECCOMP_FILTER_FLAG_TSYNC : 0U, &p);
 if (r != 0) _exit(91);
}
static void *mutator(void *p) {
 struct shared *s = p;
 atomic_store(&s->mutator_tid, (int)syscall(SYS_gettid));
 while (atomic_load(&s->phase) != 1) syscall(SYS_sched_yield);
 s->iov.iov_len = 2;
 atomic_store(&s->phase, 2);
 for (;;) syscall(SYS_sched_yield);
 return NULL;
}
static void checked_write(struct shared *s, int fd, const void *p, size_t n, int expect) {
 errno = 0; long r = syscall(SYS_write, fd, p, n);
 if ((expect >= 0 && r == expect) || (expect == -1 && r == -1 && errno == EDQUOT)) atomic_fetch_add(&s->ok, 1);
 else atomic_fetch_add(&s->errors, 1);
}
static void denied_call(struct shared *s, long r, int e) {
 if (r == -1 && e == EPERM) atomic_fetch_add(&s->denied, 1);
 else atomic_fetch_add(&s->errors, 1);
}
static void child_main(struct shared *s, const char *name, int index) {
 /* No parent-owned endpoints/report/listener/directory survive fixture bootstrap. */
 if (syscall(SYS_close_range, 3U, 102U, 0U) != 0 || syscall(SYS_close_range, 104U, UINT_MAX, 0U) != 0) _exit(92);
 close(0);
 int race = strcmp(name, "B06") == 0 || strcmp(name, "R01") == 0;
 pthread_t thread;
 if (race) {
  s->data[0] = 'a'; s->data[1] = 'b'; s->iov.iov_base = s->data; s->iov.iov_len = 1;
  if (pthread_create(&thread, NULL, mutator, s) != 0) _exit(93);
  while (atomic_load(&s->mutator_tid) == 0) syscall(SYS_sched_yield);
 }
 install_strict(race);
 atomic_store(&s->ready[index], 1);
 while (atomic_load(&s->go) == 0) syscall(SYS_sched_yield);
 char bytes[16384]; memset(bytes, 'x', sizeof(bytes));
 if (strcmp(name, "B01") == 0) {
  for (unsigned k = 0; k < OUT_CAP / CHUNK; k++) checked_write(s, k % 2 ? 103 : 1, bytes, CHUNK, CHUNK);
  checked_write(s, 103, bytes, 1, -1);
  for (unsigned k = 0; k < OUT_CAP / CHUNK; k++) checked_write(s, 2, bytes, CHUNK, CHUNK);
  checked_write(s, 2, bytes, 1, -1);
 } else if (strcmp(name, "B02") == 0) {
  errno = 0; long r = syscall(SYS_write, 1, bytes, CHUNK);
  if (r == CHUNK) atomic_fetch_add(&s->ok, 1);
  else if (r == -1 && errno == EDQUOT) atomic_fetch_add(&s->denied, 1);
  else atomic_fetch_add(&s->errors, 1);
 } else if (strcmp(name, "B03") == 0) {
#define BAD_CALL(expr) do { errno = 0; long value = (expr); int saved = errno; denied_call(s, value, saved); } while (0)
  BAD_CALL(syscall(SYS_dup, 1));
  BAD_CALL(syscall(SYS_dup2, 1, 103));
  BAD_CALL(syscall(SYS_openat, AT_FDCWD, "/dev/null", O_WRONLY, 0));
  BAD_CALL(syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, NULL));
  BAD_CALL(syscall(SYS_prctl, PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  BAD_CALL(syscall(SYS_sendfile, 1, 103, NULL, 1));
  BAD_CALL(syscall(SYS_mmap, NULL, CHUNK, PROT_READ, MAP_PRIVATE, 103, 0));
  BAD_CALL(syscall(999999L));
  BAD_CALL(syscall(X32_BIT | SYS_write, 1, bytes, 1));
  BAD_CALL(syscall(SYS_writev, 1, &s->iov, 1));
  BAD_CALL(syscall(SYS_close, 103));
  BAD_CALL(syscall(SYS_clone3, NULL, 0));
#undef BAD_CALL
 } else if (strcmp(name, "B04") == 0) {
  checked_write(s, 1, bytes, 8192, 4096);
 } else if (strcmp(name, "B05") == 0) {
  (void)syscall(SYS_write, 1, bytes, 1);
  atomic_fetch_add(&s->errors, 1); /* Parent must kill before SEND, no return. */
 } else if (race) {
  errno = 0; long r = syscall(SYS_writev, 1, &s->iov, 1);
  int expected = strcmp(name, "R01") == 0 ? 2 : 1;
  if (r == expected) atomic_fetch_add(&s->ok, 1); else atomic_fetch_add(&s->errors, 1);
 }
 syscall(SYS_exit_group, 0);
 _exit(94);
}
static void drain(struct broker *b, int which, size_t limit) {
 unsigned char data[4096]; size_t total = 0;
 while (total < limit) {
  size_t want = limit - total; if (want > sizeof(data)) want = sizeof(data);
  ssize_t n = read(b->rd[which], data, want);
  if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) break;
  REQUIRE(n >= 0, "pipe observation read"); if (n == 0) break;
  total += (size_t)n; b->observed[which] += (uint64_t)n;
  for (ssize_t i = 0; i < n; i++) { b->hashes[which] ^= data[i]; b->hashes[which] *= UINT64_C(1099511628211); }
 }
}
static io_status_v1 reserve(struct broker *b, pid_t task, int stream, size_t n, io_ticket_v1 *t) {
 io_request_v1 r = {.domain = {31, 1}, .task = {31, (uint64_t)task},
  .object = {31, (uint64_t)(stream + 10)}, .operation_id = ++b->operation,
  .object_class = stream ? IO_STDERR_V1 : IO_STDOUT_V1, .direction = IO_WRITE_V1, .requested = n};
 return io_reserve_v1(b->domain, &r, t);
}
static void accounted_setup_write(struct broker *b, size_t n, int observe) {
 char data[4096]; memset(data, 'p', sizeof(data)); REQUIRE(n <= sizeof(data), "setup bound");
 io_ticket_v1 ticket;
 REQUIRE(reserve(b, getpid(), 0, n, &ticket) == IO_ALLOWED_V1, "setup reserve");
 ssize_t k = write(b->outfd, data, n); REQUIRE(k == (ssize_t)n, "setup actual effect");
 REQUIRE(io_complete_v1(b->domain, &ticket, true, (uint64_t)k) == IO_ALLOWED_V1, "setup settle");
 b->prefill += (uint64_t)k;
 if (observe) drain(b, 0, CHUNK);
}
static int owned(struct broker *b, pid_t task) {
 for (int i = 0; i < b->workers; i++) if (b->children[i] == task) return 1;
 return 0;
}
static void copy_from_child(pid_t task, void *dest, uint64_t remote, size_t n) {
 struct iovec local = {.iov_base = dest, .iov_len = n};
 struct iovec foreign = {.iov_base = (void *)(uintptr_t)remote, .iov_len = n};
 REQUIRE(process_vm_readv(task, &local, 1, &foreign, 1, 0) == (ssize_t)n, "own-child pointer copy");
}
static int valid_id(int listener, uint64_t id) { return ioctl(listener, SECCOMP_IOCTL_NOTIF_ID_VALID, &id); }
static void handle(struct broker *b, struct shared *s, const char *name, struct seccomp_notif *n) {
 REQUIRE(!b->adapter_hold, "no-next after HOLD");
 REQUIRE(owned(b, (pid_t)n->pid) && n->data.arch == AUDIT_ARCH_X86_64, "notification identity");
 REQUIRE(n->data.nr == SYS_write || n->data.nr == SYS_writev, "notification syscall");
 uint64_t fd = n->data.args[0]; REQUIRE(fd == 1 || fd == 2 || fd == 103, "fixed FD identity");
 REQUIRE(valid_id(b->listener, n->id) == 0, "notification current ID");
 int stream = fd == 2 ? 1 : 0; size_t length; unsigned char data[16384];
 if (n->data.nr == SYS_writev) {
  REQUIRE(strcmp(name, "B06") == 0 || strcmp(name, "R01") == 0, "writev selected case");
  REQUIRE(n->data.args[2] == 1, "one iovec"); struct iovec iov;
  copy_from_child((pid_t)n->pid, &iov, n->data.args[1], sizeof(iov));
  REQUIRE(iov.iov_len == 1, "original pointer length"); length = iov.iov_len;
  copy_from_child((pid_t)n->pid, data, (uint64_t)(uintptr_t)iov.iov_base, length);
  atomic_store(&s->phase, 1);
  while (atomic_load(&s->phase) != 2) sched_yield();
 } else {
  REQUIRE(n->data.args[2] <= sizeof(data), "request bound"); length = (size_t)n->data.args[2];
  copy_from_child((pid_t)n->pid, data, n->data.args[1], length);
 }
 io_ticket_v1 ticket; io_status_v1 admission = reserve(b, (pid_t)n->pid, stream, length, &ticket);
 struct seccomp_notif_resp response; memset(&response, 0, sizeof(response)); response.id = n->id;
 if (b->notifications == 0) { b->first_id = n->id; b->first_task = n->pid; }
 b->last_id = n->id; b->last_task = n->pid; b->notifications++;
 if (admission == IO_DENIED_V1) { b->denied++; response.error = -EDQUOT; }
 else {
  REQUIRE(admission == IO_ALLOWED_V1, "I/O admission"); b->allowed++;
#if P31_NEGATIVE_CONTROL
  REQUIRE(strcmp(name, "R01") == 0 && length == 1, "negative-only build");
  response.flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
  REQUIRE(ioctl(b->listener, SECCOMP_IOCTL_NOTIF_SEND, &response) == 0, "negative SEND");
  /* Intentionally no false completion: actual kernel reread2 exceeds reserved1. */
  REQUIRE(io_complete_v1(b->domain, &ticket, false, 0) == IO_HELD_V1, "negative hold");
  b->adapter_hold = 1; return;
#else
  REQUIRE(strcmp(name, "R01") != 0, "positive build rejects red");
  ssize_t actual = write(stream ? b->errfd : b->outfd, data, length);
  if (actual < 0) {
   (void)io_complete_v1(b->domain, &ticket, false, 0); b->adapter_hold = 1;
   fail("unknown guard effect");
  }
  REQUIRE((uint64_t)actual <= length, "bounded signed return");
  REQUIRE(io_complete_v1(b->domain, &ticket, true, (uint64_t)actual) == IO_ALLOWED_V1, "known completion");
  b->actual += (uint64_t)actual; response.val = actual;
  if (strcmp(name, "B04") == 0) b->partial = (uint64_t)actual;
  drain(b, stream, SIZE_MAX);
  if (strcmp(name, "B05") == 0) {
   REQUIRE(kill((pid_t)n->pid, SIGKILL) == 0, "owned cancellation"); int status;
   REQUIRE(waitpid((pid_t)n->pid, &status, 0) == (pid_t)n->pid && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL, "cancel reap");
   b->children[0] = 0;
   errno = 0; int sent = ioctl(b->listener, SECCOMP_IOCTL_NOTIF_SEND, &response); int send_errno = errno;
   REQUIRE(sent == -1 && send_errno == ENOENT, "actual stale SEND");
   errno = 0; REQUIRE(valid_id(b->listener, n->id) == -1 && errno == ENOENT, "actual stale ID");
   b->send_failed++; b->adapter_hold = 1; return;
  }
#endif
 }
 REQUIRE(ioctl(b->listener, SECCOMP_IOCTL_NOTIF_SEND, &response) == 0, "notification SEND");
}
/* Test-only GNU-ld --wrap observers. They preserve real core semantics and
 * count actual API entries, including accidental initialization/close/snapshot.
 * No old core file is changed and these are not an admission capability. */
static unsigned journal_api_calls[8];
extern lj_result_v1 __real_lj_sink_create_v1(lj_sink_v1 *, int, const char *, lj_cookie_v1);
lj_result_v1 __wrap_lj_sink_create_v1(lj_sink_v1 *s, int fd, const char *name, lj_cookie_v1 d) {
 journal_api_calls[0]++; return __real_lj_sink_create_v1(s, fd, name, d);
}
extern void __real_lj_sink_close_v1(lj_sink_v1 *);
void __wrap_lj_sink_close_v1(lj_sink_v1 *s) { journal_api_calls[1]++; __real_lj_sink_close_v1(s); }
extern lj_result_v1 __real_lj_init_v1(lj_domain_v1 *, lj_slot_v1 *, size_t, size_t, lj_cookie_v1, lj_cookie_v1, lj_sink_v1 *);
lj_result_v1 __wrap_lj_init_v1(lj_domain_v1 *d, lj_slot_v1 *s, size_t n, size_t u, lj_cookie_v1 c, lj_cookie_v1 o, lj_sink_v1 *k) {
 journal_api_calls[2]++; return __real_lj_init_v1(d, s, n, u, c, o, k);
}
extern lj_result_v1 __real_lj_reserve_v1(lj_domain_v1 *, lj_kind_v1, lj_cookie_v1, lj_cookie_v1, lj_cookie_v1, lj_ticket_v1 *);
lj_result_v1 __wrap_lj_reserve_v1(lj_domain_v1 *d, lj_kind_v1 k, lj_cookie_v1 t, lj_cookie_v1 p, lj_cookie_v1 r, lj_ticket_v1 *o) {
 journal_api_calls[3]++; return __real_lj_reserve_v1(d, k, t, p, r, o);
}
extern lj_result_v1 __real_lj_report_v1(lj_domain_v1 *, const lj_ticket_v1 *, lj_event_v1, uint64_t, lj_cookie_v1);
lj_result_v1 __wrap_lj_report_v1(lj_domain_v1 *d, const lj_ticket_v1 *t, lj_event_v1 e, uint64_t o, lj_cookie_v1 r) {
 journal_api_calls[4]++; return __real_lj_report_v1(d, t, e, o, r);
}
extern lj_result_v1 __real_lj_unknown_v1(lj_domain_v1 *, const lj_ticket_v1 *);
lj_result_v1 __wrap_lj_unknown_v1(lj_domain_v1 *d, const lj_ticket_v1 *t) { journal_api_calls[5]++; return __real_lj_unknown_v1(d, t); }
extern lj_result_v1 __real_lj_flush_v1(lj_domain_v1 *, const lj_ticket_v1 *);
lj_result_v1 __wrap_lj_flush_v1(lj_domain_v1 *d, const lj_ticket_v1 *t) { journal_api_calls[6]++; return __real_lj_flush_v1(d, t); }
extern lj_snapshot_v1 __real_lj_snapshot_v1_get(lj_domain_v1 *);
lj_snapshot_v1 __wrap_lj_snapshot_v1_get(lj_domain_v1 *d) { journal_api_calls[7]++; return __real_lj_snapshot_v1_get(d); }
static int run_journal_negative(const char *directory) {
 /* No producers exist. The negative adapter rejects BEFORE creating/initializing
  * any journal/sink, reserving a ticket, reporting, flushing or payload effect.
  * active0 below means NO context, not a successful journal snapshot. */
 const void *authentic_prebirth = NULL, *authentic_release = NULL;
 int adapter_hold = authentic_prebirth == NULL || authentic_release == NULL;
 REQUIRE(adapter_hold, "missing authentic lifecycle capability");
 unsigned calls = 0; for (size_t i = 0; i < ARRAY_LEN(journal_api_calls); i++) calls += journal_api_calls[i];
 REQUIRE(calls == 0, "actual wrapped journal API calls before missing-capability HOLD");
 int dir = open(directory, O_DIRECTORY|O_RDONLY|O_CLOEXEC); REQUIRE(dir >= 0, "private evidence dir");
 struct stat st; errno = 0;
 REQUIRE(fstatat(dir, "journal-negative.bin", &st, AT_SYMLINK_NOFOLLOW) == -1 && errno == ENOENT, "no journal sink exists");
 int receipt = openat(dir, "engineering-receipt.json", O_CREAT|O_EXCL|O_WRONLY|O_CLOEXEC|O_NOFOLLOW, 0600);
 REQUIRE(receipt >= 0, "engineering receipt create");
 const char text[] = "{\"adapter\":\"HOLD\",\"journal_initialized\":false,\"sink_creates\":0,\"journal_reserve_report_flush_calls\":0,\"payload_effects\":0,\"qualification\":false}\n";
 REQUIRE(write(receipt, text, sizeof(text)-1) == (ssize_t)(sizeof(text)-1) && fsync(receipt) == 0, "engineering receipt durability");
 REQUIRE(close(receipt) == 0 && fsync(dir) == 0, "engineering directory durability");
 close(dir);
 dprintf(report_fd, "{\"case\":\"B07\",\"result\":\"PASS\",\"adapter_hold\":true,\"journal_initialized\":false,\"journal_active\":0,\"sink_creates\":%u,\"journal_bytes\":0,\"journal_calls\":%u,\"wrapped_api_counts\":[%u,%u,%u,%u,%u,%u,%u,%u],\"payload_bytes\":0,\"fixture_children\":0,\"qualification\":false}\n",
 journal_api_calls[0], calls, journal_api_calls[0], journal_api_calls[1], journal_api_calls[2], journal_api_calls[3], journal_api_calls[4], journal_api_calls[5], journal_api_calls[6], journal_api_calls[7]);
 return 0;
}
int main(int argc, char **argv) {
 if (argc == 2 && strcmp(argv[1], "--describe") == 0) { describe(); return 0; }
 if (argc != 3) return 2;
 const char *name = argv[1];
#if P31_NEGATIVE_CONTROL
 if (strcmp(name, "R01") != 0) return 2;
#else
 if (strlen(name) != 3 || name[0] != 'B' || name[1] != '0' || name[2] < '1' || name[2] > '7') return 2;
#endif
 report_fd = guard_dup(STDOUT_FILENO); diagnostic_fd = guard_dup(STDERR_FILENO);
 if (strcmp(name, "B07") == 0) return run_journal_negative(argv[2]);
 struct shared *s = mmap(NULL, sizeof(*s), PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0);
 REQUIRE(s != MAP_FAILED, "shared fixture setup"); memset(s, 0, sizeof(*s));
 for (int i = 0; i < 2; i++) atomic_init(&s->ready[i], 0);
 atomic_init(&s->go, 0); atomic_init(&s->phase, 0); atomic_init(&s->errors, 0);
 atomic_init(&s->denied, 0); atomic_init(&s->ok, 0); atomic_init(&s->mutator_tid, 0);
 int pipes[2][2]; REQUIRE(pipe2(pipes[0], O_CLOEXEC|O_NONBLOCK) == 0 && pipe2(pipes[1], O_CLOEXEC|O_NONBLOCK) == 0, "private pipes");
 struct broker b; memset(&b, 0, sizeof(b)); b.hashes[0] = b.hashes[1] = UINT64_C(14695981039346656037);
 b.rd[0] = guard_dup(pipes[0][0]); b.rd[1] = guard_dup(pipes[1][0]);
 b.outfd = guard_dup(pipes[0][1]); b.errfd = guard_dup(pipes[1][1]);
 REQUIRE(fstat(b.outfd, &b.pipe_identity[0]) == 0 && fstat(b.errfd, &b.pipe_identity[1]) == 0, "actual pipe guard metadata");
 REQUIRE(dup2(pipes[0][1], 1) == 1 && dup2(pipes[1][1], 2) == 2 && dup2(pipes[0][1], 103) == 103, "fixed payload map");
 for (int i = 0; i < 2; i++) { close(pipes[i][0]); close(pipes[i][1]); }
 REQUIRE(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0, "no_new_privs");
 struct sock_fprog filter = {.len = (unsigned short)ARRAY_LEN(notify_filter), .filter = (struct sock_filter *)notify_filter};
 b.listener = (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &filter);
 REQUIRE(b.listener >= 0, "own NEW_LISTENER feature");
 b.workers = strcmp(name, "B02") == 0 ? 2 : 1;
 for (int i = 0; i < b.workers; i++) {
  pid_t p = fork(); REQUIRE(p >= 0, "owned fixture fork");
  if (p == 0) child_main(s, name, i);
  b.children[i] = p; b.born[i] = p;
 }
 close(1); close(2); close(103);
 /* P30 live context is initialized only after every fork. */
 io_domain_v1 domain = IO_DOMAIN_V1_INITIALIZER; io_slot_v1 slots[4]; b.domain = &domain;
 unsigned char wire[8192]; const rp_policy_v1 *policy = NULL; rp_limits_v1 limits;
 REQUIRE(rp_wire_size_v1() <= sizeof(wire) && rp_write_wire_v1(wire, sizeof(wire)) == 1 && rp_decode_v1(wire, rp_wire_size_v1(), &policy) == 1, "canonical policy");
 REQUIRE(rp_get_limits_v1(policy, &limits) == 1 && limits.io_caps[6] == OUT_CAP && limits.io_caps[7] == BOTH_CAP, "canonical caps");
 REQUIRE(io_init_v1(&domain, policy, (io_cookie_v1){31, 1}, slots, ARRAY_LEN(slots)) == IO_ALLOWED_V1, "postfork IO init");
 int capacity = fcntl(b.outfd, F_GETPIPE_SZ); REQUIRE(capacity >= 4096 && capacity <= 65536, "measured bounded pipe capacity");
 if (strcmp(name, "B02") == 0) for (unsigned i = 0; i < OUT_CAP / CHUNK - 1; i++) accounted_setup_write(&b, CHUNK, 1);
 if (strcmp(name, "B04") == 0) {
  REQUIRE(capacity % CHUNK == 0, "partial pipe page shape");
  for (int i = 0; i < capacity / (int)CHUNK; i++) accounted_setup_write(&b, CHUNK, 0);
  drain(&b, 0, CHUNK);
 }
 struct seccomp_notif_sizes sizes; REQUIRE(syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) == 0, "actual notification sizes");
 REQUIRE(sizes.seccomp_notif >= sizeof(struct seccomp_notif) && sizes.seccomp_notif <= 4096, "notification buffer bound");
 struct seccomp_notif *notification = calloc(1, sizes.seccomp_notif); REQUIRE(notification != NULL, "notification allocation");
 for (int i = 0; i < b.workers; i++) {
  while (!atomic_load(&s->ready[i])) {
   int status; pid_t p = waitpid(b.children[i], &status, WNOHANG);
   REQUIRE(p == 0, "child bootstrap strictfilter"); sched_yield();
  }
 }
 atomic_store(&s->go, 1);
 unsigned reaped = 0; int statuses[2] = {0, 0};
 while (reaped < (unsigned)b.workers) {
  struct pollfd p = {.fd = b.listener, .events = POLLIN}; int ready = poll(&p, 1, 20); REQUIRE(ready >= 0 || errno == EINTR, "listener poll");
  if (ready > 0 && (p.revents & POLLIN)) {
   memset(notification, 0, sizes.seccomp_notif);
   if (ioctl(b.listener, SECCOMP_IOCTL_NOTIF_RECV, notification) == 0) handle(&b, s, name, notification);
   else REQUIRE(errno == EINTR || errno == ENOENT, "notification RECV");
  }
  for (int i = 0; i < b.workers; i++) {
   if (b.children[i] == 0) { if (!statuses[i]) { statuses[i] = 1; reaped++; } continue; }
   int status; pid_t pchild = waitpid(b.children[i], &status, WNOHANG);
   REQUIRE(pchild >= 0, "owned wait");
   if (pchild) { REQUIRE(WIFEXITED(status) && WEXITSTATUS(status) == 0, "child actual exit"); b.children[i] = 0; statuses[i] = 1; reaped++; }
  }
 }
 drain(&b, 0, SIZE_MAX); drain(&b, 1, SIZE_MAX);
 io_snapshot_v1 snap; io_status_v1 snap_status = io_snapshot_get_v1(&domain, &snap);
 REQUIRE(snap_status == (P31_NEGATIVE_CONTROL ? IO_HELD_V1 : IO_ALLOWED_V1), "counter snapshot");
 REQUIRE(atomic_load(&s->errors) == 0, "child semantic assertions");
 int pass = 0;
 if (strcmp(name, "B01") == 0) pass = b.observed[0] == OUT_CAP && b.observed[1] == OUT_CAP && b.denied == 2 && b.allowed == 512 && snap.used[6] == OUT_CAP && snap.used[7] == BOTH_CAP;
 if (strcmp(name, "B02") == 0) pass = b.observed[0] == OUT_CAP && b.allowed == 1 && b.denied == 1 && atomic_load(&s->ok) == 1 && atomic_load(&s->denied) == 1 && snap.used[6] == OUT_CAP;
 if (strcmp(name, "B03") == 0) pass = atomic_load(&s->denied) == 12 && b.observed[0] == 0 && b.observed[1] == 0 && b.notifications == 0 && snap.used[7] == 0;
 if (strcmp(name, "B04") == 0) pass = b.partial == 4096 && b.observed[0] == b.prefill + 4096 && snap.used[6] == b.prefill + 4096 && !snap.held;
 if (strcmp(name, "B05") == 0) pass = b.observed[0] == 1 && b.actual == 1 && snap.used[6] == 1 && !snap.held && b.send_failed == 1 && b.adapter_hold;
 if (strcmp(name, "B06") == 0) pass = b.observed[0] == 1 && b.actual == 1 && snap.used[6] == 1 && atomic_load(&s->ok) == 1;
 if (strcmp(name, "R01") == 0) pass = b.observed[0] == 2 && snap.used[6] == 1 && snap.held && b.adapter_hold && atomic_load(&s->ok) == 1;
 REQUIRE(pass, "case expected actual effects");
 dprintf(report_fd, "{\"case\":\"%s\",\"result\":\"%s\",\"notifications\":%u,\"allowed\":%u,\"denied\":%u,\"stdout_observed\":%" PRIu64 ",\"stderr_observed\":%" PRIu64 ",\"stdout_fnv64\":\"%016" PRIx64 "\",\"stderr_fnv64\":\"%016" PRIx64 "\",\"actual_guard_bytes\":%" PRIu64 ",\"prefill_bytes\":%" PRIu64 ",\"known_partial\":%" PRIu64 ",\"used_stdout\":%" PRIu64 ",\"used_combined\":%" PRIu64 ",\"core_held\":%s,\"adapter_hold\":%s,\"send_failed\":%u,\"strict_denials\":%d,\"fixture_children\":%d,\"children_reaped\":%u,\"mutator_tid\":%d,\"pipe_capacity\":%d,\"owned_pids\":[%d,%d],\"first_notif_id\":%" PRIu64 ",\"last_notif_id\":%" PRIu64 ",\"first_notif_task\":%u,\"last_notif_task\":%u,\"listener_fd\":%d,\"guard_fds\":[%d,%d],\"pipe_inodes\":[%" PRIuMAX ",%" PRIuMAX "],\"qualification\":false}\n",
 name, strcmp(name, "R01") == 0 ? "COUNTEREXAMPLE_OBSERVED" : "PASS", b.notifications, b.allowed, b.denied, b.observed[0], b.observed[1], b.hashes[0], b.hashes[1], b.actual, b.prefill, b.partial, snap.used[6], snap.used[7], snap.held ? "true" : "false", b.adapter_hold ? "true" : "false", b.send_failed, atomic_load(&s->denied), b.workers, reaped, atomic_load(&s->mutator_tid), capacity, (int)b.born[0], (int)b.born[1], b.first_id, b.last_id, b.first_task, b.last_task, b.listener, b.outfd, b.errfd, (uintmax_t)b.pipe_identity[0].st_ino, (uintmax_t)b.pipe_identity[1].st_ino);
 free(notification); close(b.listener); close(b.outfd); close(b.errfd); close(b.rd[0]); close(b.rd[1]);
 return 0;
}

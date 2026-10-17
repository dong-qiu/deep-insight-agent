#ifndef RESOURCE_POLICY_V1_H
#define RESOURCE_POLICY_V1_H
#include <stddef.h>
#include <stdint.h>

/* Canonical policy identity only; never an executor-admission capability. */
typedef struct rp_policy_v1 rp_policy_v1;
typedef struct {
    uint64_t scratch_bytes, memory_max, swap_max, pids_max;
    uint64_t child_seconds, grace_seconds, descriptor_bytes, diagnostic_bytes;
    uint64_t batch_seconds, control_frame_bytes, control_silence_seconds;
    uint64_t io_caps[8];
} rp_limits_v1;

size_t rp_wire_size_v1(void);
int rp_write_wire_v1(uint8_t *out, size_t capacity);
int rp_decode_v1(const uint8_t *wire, size_t length, const rp_policy_v1 **out);
int rp_get_limits_v1(const rp_policy_v1 *policy, rp_limits_v1 *out);
const char *rp_payload_v1(void);
const char *rp_payload_sha256_v1(void);
#endif

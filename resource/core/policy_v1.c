#include "policy_v1.h"
#include <string.h>
struct rp_policy_v1 { unsigned version; };
static const rp_policy_v1 canonical_policy = { 1 };
static const char payload[] = "{\"collector\":\"ptrace-TRACEME-kernel-stops-with-inherited-seccomp\",\"controlLease\":{\"maxFrameBytes\":4096,\"maxSilenceSeconds\":30,\"schema\":\"r3-resource-lease-v1\",\"transport\":\"trusted supervisor stdin FIFO; EOF/sequence loss quarantines\"},\"descriptorPolicy\":{\"allowedTerminal\":{\"aggregate-write64\":\"originallauncher EXIT0\",\"deadline-descendant-close\":\"exact originalprobe\\u2192fork-and-exit EXIT0\\u2192park liveatdeadline SIGKILL\",\"memory-tree256-swap0\":\"boundmemoryworker SIGKILL with owncgroup oom_kill delta; no deadline\",\"outside-write-denial\":\"originallauncher EXIT0\",\"pids-tree16\":\"boundparkworker plus parent EAGAIN and owncgroup maxdelta; owned SIGKILL\"},\"headerFields\":[\"schema\",\"mode\",\"pid\"],\"partialFrames\":\"forbidden; incomplete JSON is UNKNOWN\",\"roles\":{\"deadline-descendant-close\":[\"fork-and-exit\",\"park\"],\"memory-tree256-swap0\":[\"memory\"],\"pids-tree16\":[\"park\"]},\"unknownFields\":\"reject\",\"workerFields\":[\"schema\",\"worker\",\"pid\",\"parentPID\"]},\"devicePolicy\":{\"IOEnforcement\":\"UNIMPLEMENTED cumulative device/pipe byte-bound kernel hook; acceptance gate unconditionally refuses execution. Inventory source only; no efficacy claim.\",\"devices\":{\"null\":{\"major\":1,\"minor\":3,\"mode\":384,\"readBytes\":1048576,\"writeBytes\":1048576},\"urandom\":{\"major\":1,\"minor\":9,\"mode\":256,\"readBytes\":1048576,\"writeBytes\":0},\"zero\":{\"major\":1,\"minor\":5,\"mode\":256,\"readBytes\":1048576,\"writeBytes\":0}},\"extra\":\"reject before Node runtime resume\",\"names\":[\"null\",\"zero\",\"urandom\",\"shm\"],\"pipes\":{\"combinedBytes\":2097152,\"stdoutBytes\":1048576}},\"limits\":{\"batchSeconds\":1200,\"childSeconds\":120,\"descriptorBytes\":1048576,\"diagnosticBytes\":2097152,\"graceSeconds\":2,\"memoryMax\":268435456,\"pidsMax\":16,\"scratchBytes\":67108864,\"swapMax\":0},\"measurement\":\"cgroup-v2 tree charged memory, swap disabled; no V8 heap or sum-RSS qualification\",\"modes\":[\"outside-write-denial\",\"aggregate-write64\",\"memory-tree256-swap0\",\"pids-tree16\",\"deadline-descendant-close\"],\"nodeConfig\":\"622f209f6c16ba5af4d9a337cae6577d096f17174b904cfc6a5b0c81a2679c24\",\"nodeManifest\":\"e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174\",\"policySHA256\":{\"override\":\"b347111880c8ddc3cf60e63fa56561cfa6407282645d05a3574104cccba73c57\",\"plan\":\"92a1ab9526bcf48e269837871fdf1c4c3405ce66d06d01441cccb963dd8ffdfb\",\"sheet\":\"64fb149678cbcef8cbadc9df98caf4af04f46c16fe3bd30cd0800e8a565d285e\"},\"probe\":\"/tools/resource-probe.mjs\",\"qualification\":\"resource-only; root acceptance of exact source/kernel required before gated exec\",\"runtime\":\"/usr/local/bin/node\",\"schema\":\"r3-resource-policy-v1\",\"scratchAliases\":[\"/work\",\"/tmp\",\"/var/tmp\",\"/usr/tmp\",\"/dev/shm\"],\"unsupported\":[\"nonleader-exec\",\"TRACEME-group-stop\",\"missing-task-identity\",\"collector-loss\",\"connection-loss\"],\"usagePolicy\":{\"after\":\"all numeric; memorycurrent/peak<=268435456 swapcurrent/peak=0 pidscurrent/peak<=16; currentpids0 atterminal\",\"before\":\"all numeric zero; exact cgroup/ancestor controller/identity snapshots\",\"required\":[\"memory.current\",\"memory.peak\",\"memory.swap.current\",\"memory.swap.peak\",\"pids.current\",\"pids.peak\"],\"unsupported\":\"UNKNOWN/no nextchild\"}}";
static const char payload_sha[] = "22b76496adbaf6aa6738a45d368c8d94148b08492f4115929eeb879bfe9836d4";
enum { HEADER_BYTES = 24 };
size_t rp_wire_size_v1(void) { return HEADER_BYTES + sizeof(payload) - 1; }
const char *rp_payload_v1(void) { return payload; }
const char *rp_payload_sha256_v1(void) { return payload_sha; }
int rp_write_wire_v1(uint8_t *out, size_t capacity) {
    size_t n = rp_wire_size_v1();
    if (out == NULL || capacity < n || n > UINT32_MAX) return 0;
    memset(out, 0, HEADER_BYTES);
    memcpy(out, "IARC0001", 8);
    out[11] = 1;
    uint32_t total = (uint32_t)n;
    for (unsigned i = 0; i < 4; i++) out[12 + i] = (uint8_t)(total >> (24U - i * 8U));
    memcpy(out + HEADER_BYTES, payload, sizeof(payload) - 1);
    return 1;
}
int rp_decode_v1(const uint8_t *wire, size_t length, const rp_policy_v1 **out) {
    if (out == NULL) return 0;
    *out = NULL;
    if (wire == NULL || length != rp_wire_size_v1() || memcmp(wire, "IARC0001", 8) != 0) return 0;
    if (wire[8] != 0 || wire[9] != 0 || wire[10] != 0 || wire[11] != 1) return 0;
    uint32_t total = 0;
    for (unsigned i = 0; i < 4; i++) total = (total << 8) | wire[12 + i];
    if ((size_t)total != length) return 0;
    for (size_t i = 16; i < HEADER_BYTES; i++) if (wire[i] != 0) return 0;
    if (memcmp(wire + HEADER_BYTES, payload, sizeof(payload) - 1) != 0) return 0;
    *out = &canonical_policy;
    return 1;
}
int rp_get_limits_v1(const rp_policy_v1 *policy, rp_limits_v1 *out) {
    if (out == NULL) return 0;
    memset(out, 0, sizeof(*out));
    if (policy != &canonical_policy) return 0;
    out->scratch_bytes = UINT64_C(67108864); out->memory_max = UINT64_C(268435456);
    out->swap_max = 0; out->pids_max = 16; out->child_seconds = 120; out->grace_seconds = 2;
    out->descriptor_bytes = UINT64_C(1048576); out->diagnostic_bytes = UINT64_C(2097152);
    out->batch_seconds = 1200; out->control_frame_bytes = 4096; out->control_silence_seconds = 30;
    const uint64_t caps[8] = {1048576,1048576,1048576,0,1048576,0,1048576,2097152};
    memcpy(out->io_caps, caps, sizeof(caps));
    return 1;
}

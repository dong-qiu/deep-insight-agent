#ifndef RESOURCE_LIFETIME_SINK_V1_H
#define RESOURCE_LIFETIME_SINK_V1_H
#include "lifetime_journal_v1.h"
/* Internal receiver operation; never a caller-provided success receipt. */
lj_result_v1 lj_sink_append_internal_v1(lj_sink_v1 *, lj_cookie_v1 domain,
                                       uint64_t sequence, const unsigned char *record);
#endif

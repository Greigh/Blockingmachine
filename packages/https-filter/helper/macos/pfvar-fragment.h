/*
 * Minimal vendored fragment of XNU's <bsd/net/pfvar.h> — the definitions
 * natlook-helper.c needs for the DIOCNATLOOK ioctl and nothing else.
 *
 * pfvar.h is a PRIVATE Apple header: it exists in the published XNU source
 * but is not shipped in any macOS SDK, so `#include <net/pfvar.h>` cannot
 * compile here. natlook-helper.c prefers the real header when one is on the
 * include path (`__has_include`) and falls back to this file otherwise — the
 * declarations below are copied verbatim (layout-identical, no hand-rolled
 * re-derivation) from apple-oss-distributions/xnu, bsd/net/pfvar.h, whose
 * license notice is reproduced as required:
 *
 *   Copyright (c) 2007-2024 Apple Inc. All rights reserved.
 *   Copyright (c) 2001 Daniel Hartmeier
 *
 *   Redistribution and use in source and binary forms, with or without
 *   modification, are permitted provided that the following conditions
 *   are met:
 *
 *      - Redistributions of source code must retain the above copyright
 *        notice, this list of conditions and the following disclaimer.
 *      - Redistributions in binary form must reproduce the above
 *        copyright notice, this list of conditions and the following
 *        disclaimer in the documentation and/or other materials provided
 *        with the distribution.
 *
 *   THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 *   "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 *   LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
 *   FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 *   COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT,
 *   INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING,
 *   BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 *   LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 *   CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 *   LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN
 *   ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *   POSSIBILITY OF SUCH DAMAGE.
 *
 * Layout invariants the ioctl ABI depends on are compile-time asserted in
 * natlook-helper.c — a struct-size drift changes the encoded ioctl number
 * and every lookup would fail ENOTTY, which is the failure mode static
 * asserts exist to catch at build time instead.
 */

#ifndef BM_PFVAR_FRAGMENT_H
#define BM_PFVAR_FRAGMENT_H

#include <netinet/in.h>
#include <sys/ioccom.h>
#include <sys/types.h>

/* enum { PF_INOUT, PF_IN, PF_OUT } — only the member we use. */
#define PF_OUT 2

union pf_state_xport {
	u_int16_t       port;
	u_int16_t       call_id;
	u_int32_t       spi;
};

struct pf_addr {
	union {
		struct in_addr          _v4addr;
		struct in6_addr         _v6addr;
		u_int8_t                _addr8[16];
		u_int16_t               _addr16[8];
		u_int32_t               _addr32[4];
	} pfa;              /* 128-bit address */
#define v4addr  pfa._v4addr
#define v6addr  pfa._v6addr
#define addr8   pfa._addr8
#define addr16  pfa._addr16
#define addr32  pfa._addr32
};

struct pfioc_natlook {
	struct pf_addr   saddr;
	struct pf_addr   daddr;
	struct pf_addr   rsaddr;
	struct pf_addr   rdaddr;
	union pf_state_xport    sxport;
	union pf_state_xport    dxport;
	union pf_state_xport    rsxport;
	union pf_state_xport    rdxport;
	sa_family_t      af;
	u_int8_t         proto;
	u_int8_t         proto_variant;
	u_int8_t         direction;
};

#define DIOCNATLOOK     _IOWR('D', 23, struct pfioc_natlook)

#endif /* BM_PFVAR_FRAGMENT_H */

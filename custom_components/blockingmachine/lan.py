"""LAN-boundary helpers — where a bearer credential is allowed to travel.

The feed token is a LAN-scoped secret: whoever holds it can drive the hub's
mutation surface. The integration speaks plain HTTP, so the token may only be
attached when the host is provably on the local network — loopback, RFC1918/
ULA/link-local literals, or a name that cannot resolve off-LAN. A cleartext
public host still gets the request, just without the credential: an open hub
keeps working and a token-gated one answers its honest 401.

Mirrors ``isLocalNetworkHost`` in ``packages/core/src/utils/urlSafety.ts`` —
the canonical spec for the JS side. Python is its own runtime, so this module
is the mirror; keep the host lists and ranges in step with core.
"""
from __future__ import annotations

import ipaddress
import socket

_LOCAL_NAME_SUFFIXES = (".local", ".lan", ".internal", ".localhost", ".home.arpa")

_PRIVATE_V4 = (
    ipaddress.ip_network("127.0.0.0/8"),  # loopback
    ipaddress.ip_network("10.0.0.0/8"),  # RFC1918
    ipaddress.ip_network("172.16.0.0/12"),  # RFC1918
    ipaddress.ip_network("192.168.0.0/16"),  # RFC1918
    ipaddress.ip_network("169.254.0.0/16"),  # link-local
)
_PRIVATE_V6 = (
    ipaddress.ip_network("::1/128"),  # loopback
    ipaddress.ip_network("fe80::/10"),  # link-local
    ipaddress.ip_network("fc00::/7"),  # ULA
)


def host_is_local(host: str) -> bool:
    """Whether `host` is provably on the local network.

    Literal addresses are range-checked; names are trusted only when they
    cannot resolve off the LAN (``localhost``, a single label, or a reserved
    non-global suffix like ``.local``/``.lan``/``.internal``/``.localhost``/
    ``.home.arpa``). Anything else is public as far as a credential is
    concerned.
    """
    h = host.strip().lower()
    if h.startswith("[") and h.endswith("]"):
        h = h[1:-1]
    if h == "localhost" or h.endswith(_LOCAL_NAME_SUFFIXES):
        return True
    ip = _parse_ip_literal(h)
    if ip is None:
        # Not a literal: a single-label name cannot resolve off the LAN's own
        # suffix search; a dotted one can.
        return "." not in h
    # An IPv6 literal can carry a mapped v4 tail (::ffff:10.0.0.5) — unwrap it
    # so it is range-checked as the IPv4 address it actually is.
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    networks = _PRIVATE_V4 if ip.version == 4 else _PRIVATE_V6
    return any(ip in net for net in networks)


def _parse_ip_literal(host: str):
    """Parse `host` as an IP literal, including the non-dotted IPv4 spellings
    the socket layer itself accepts.

    ``urllib.parse`` does not canonicalize hostnames the way WHATWG ``URL``
    does, so ``http://2130706433/`` (127.0.0.1), ``http://0x08080808/`` and
    ``http://127.1/`` arrive verbatim — while the resolver/HTTP client will
    still route them to those addresses through ``inet_aton`` semantics. A
    single-label *number* must therefore be range-checked as the address it
    really is, not waved through as an unresolvable name — otherwise
    ``http://134744072/`` (8.8.8.8) would read as "local" and take the token.
    """
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        pass
    try:
        return ipaddress.ip_address(socket.inet_aton(host))
    except (OSError, ValueError):
        return None


def auth_headers(host: str, token: str | None) -> dict[str, str]:
    """Request headers carrying the bearer token — only when the wire allows it."""
    if token and host_is_local(host):
        return {"Authorization": f"Bearer {token}"}
    return {}

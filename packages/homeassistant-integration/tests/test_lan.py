"""Credential-scope tests: a feed token is a LAN-scoped secret and must never
ride a cleartext request to a public address."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from custom_components.blockingmachine.lan import auth_headers, host_is_local


class TestHostIsLocal(unittest.TestCase):
    def test_loopback_and_rfc1918_literals_are_local(self):
        for host in [
            "127.0.0.1",
            "10.0.0.5",
            "172.16.1.1",
            "172.31.255.254",
            "192.168.1.2",
            "169.254.1.1",
            "LOCALHOST",
            "homeassistant.local",
            "hub.lan",
            "nas.internal",
            "router",
            "::1",
            "[fe80::1]",
            "fd00::5",
            "::ffff:10.0.0.5",
            "foo.localhost",
            "printer.home.arpa",
            "2130706433",  # integer form of 127.0.0.1 — the resolver routes it
            "127.1",  # short form — likewise
            "0x7f000001",  # hex form — likewise
        ]:
            with self.subTest(host=host):
                self.assertTrue(host_is_local(host))

    def test_public_addresses_are_not_local(self):
        for host in [
            "feeds.example.com",
            "8.8.8.8",
            "172.15.0.1",  # just outside 172.16/12
            "192.167.0.1",  # just outside 192.168/16
            "9.9.9.9",
            "2001:4860:4860::8888",
            "134744072",  # integer form of 8.8.8.8 — a single-label *number* is
            # still a routed address, not an unresolvable name
            "0x08080808",  # hex 8.8.8.8
            "::",  # unspecified — nothing is provably-local about it
            "0.0.0.0",
            "100.64.0.1",  # CGNAT — carrier-shared, not the LAN
            "::ffff:8.8.8.8",  # a mapped *public* v4 is still public
        ]:
            with self.subTest(host=host):
                self.assertFalse(host_is_local(host))


class TestAuthHeaders(unittest.TestCase):
    def test_token_attaches_to_local_hosts(self):
        headers = auth_headers("homeassistant.local", "secret")
        self.assertEqual(headers, {"Authorization": "Bearer secret"})

    def test_token_is_withheld_from_public_hosts(self):
        self.assertEqual(auth_headers("feeds.example.com", "secret"), {})
        self.assertEqual(auth_headers("8.8.8.8", "secret"), {})

    def test_no_token_produces_no_header(self):
        self.assertEqual(auth_headers("127.0.0.1", None), {})
        self.assertEqual(auth_headers("8.8.8.8", None), {})


if __name__ == "__main__":
    unittest.main()

"""Exercise the bundled probe over HTTP without registry writes."""

import importlib.util
import json
import sys
from pathlib import Path
from threading import Thread
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen


sys.dont_write_bytecode = True


class RegistryHealthTest(unittest.TestCase):
    def setUp(self):
        path = Path(__file__).resolve().parents[1] / "files/registry-health.py"
        self.assertTrue(path.exists(), "Bundled registry filesystem probe is missing")
        spec = importlib.util.spec_from_file_location("registry_health", path)
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.server = self.probe.ThreadingHTTPServer(("127.0.0.1", 0), self.probe.Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:%d" % self.server.server_port
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_each_request_reads_capacity_and_nonroot_available_bytes(self):
        stats = [SimpleNamespace(f_blocks=100, f_bfree=30, f_bavail=20, f_frsize=4096),
                 SimpleNamespace(f_blocks=100, f_bfree=10, f_bavail=0, f_frsize=4096)]
        with patch.object(self.probe.os, "statvfs", side_effect=stats) as statvfs:
            with urlopen(self.url + "/health") as response:
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertEqual(json.load(response), {
                    "capacityBytes": 409600, "availableBytes": 81920, "usedBytes": 286720})
            with urlopen(self.url + "/health") as response:
                self.assertEqual(json.load(response), {
                    "capacityBytes": 409600, "availableBytes": 0, "usedBytes": 368640})
            self.assertEqual(statvfs.call_count, 2)
            statvfs.assert_called_with("/var/lib/registry")

    def test_stat_failure_does_not_serve_old_capacity(self):
        with patch.object(self.probe.os, "statvfs", side_effect=OSError("unavailable")):
            with self.assertRaises(HTTPError) as result:
                urlopen(self.url + "/health")
            self.assertEqual(result.exception.code, 503)
            self.assertNotIn("capacityBytes", json.load(result.exception))

    def test_other_paths_are_not_served(self):
        with self.assertRaises(HTTPError) as result:
            urlopen(self.url + "/v2/")
        self.assertEqual(result.exception.code, 404)


if __name__ == "__main__":
    unittest.main()

"""Cursor launcher checks with a synthetic CLI and local HTTP hub only."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest

WRAPPER = Path(__file__).resolve().parents[1] / "plugins/account-pool-balanced/scripts/cursor-route.py"
spec = importlib.util.spec_from_file_location("cursor_route", WRAPPER)
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)


class CursorRouteTest(unittest.TestCase):
    def test_direct_environment_is_unchanged(self):
        env = {"AGENT_CLI_CREDENTIAL_STORE": "system"}
        self.assertEqual(route.build_env(env), env)
        self.assertEqual(route.build_argv("cursor-agent", ["wrapper", "acp"], env), ["cursor-agent", "acp"])

    def test_custom_config_still_keeps_pooled_auth_in_memory(self):
        env = {"CURSOR_API_ENDPOINT": "http://pool.example/cursor", "CURSOR_CONFIG_DIR": "/synthetic/config", "AGENT_CLI_CREDENTIAL_STORE": "system"}
        self.assertEqual(route.build_env(env)["AGENT_CLI_CREDENTIAL_STORE"], "memory")
        self.assertEqual(route.build_env(env)["CURSOR_CONFIG_DIR"], env["CURSOR_CONFIG_DIR"])

    def test_generic_gateway_preserves_binary_stream_and_exchange(self):
        calls = []
        class Hub(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                calls.append((self.path, self.headers.get("x-bb-cursor-rpc-path"), self.headers.get("Authorization"), self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                for chunk in [b"\x00\xff", b"\x80end"]:
                    self.wfile.write(("%x\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
        hub = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hub)
        thread = threading.Thread(target=hub.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cli = Path(tmp) / "cursor-agent"
                cli.write_text("#!" + sys.executable + "\n" + '''import http.client, json, os, sys
from urllib.parse import urlsplit
endpoint = os.environ["CURSOR_API_ENDPOINT"]
assert sys.argv[-2:] == ["--agent-endpoint", endpoint]
assert os.environ["AGENT_CLI_CREDENTIAL_STORE"] == "memory"
url = urlsplit(endpoint)
for path in ["aiserver.v7.FutureService/NewTool", "auth/exchange_user_api_key"]:
    conn = http.client.HTTPConnection(url.hostname, url.port)
    conn.request("POST", "/" + path, body=b"\\x00\\xffprobe", headers={"Authorization": "Bearer synthetic-hub-token", "x-bb-cursor-rpc-path": "forged/path"})
    response = conn.getresponse()
    assert response.status == 200
    assert response.read() == b"\\x00\\xff\\x80end"
    conn.close()
print("PROBE_OK")
''')
                cli.chmod(0o755)
                env = dict(os.environ, PATH=tmp + os.pathsep + os.environ["PATH"], CURSOR_API_ENDPOINT=f"http://127.0.0.1:{hub.server_port}/cursor", CURSOR_POOL_RPC_GATEWAY="1", CURSOR_CONFIG_DIR=tmp)
                result = subprocess.run([sys.executable, str(WRAPPER), "acp"], env=env, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "PROBE_OK")
                self.assertEqual(calls, [
                    ("/cursor/rpc", "aiserver.v7.FutureService/NewTool", "Bearer synthetic-hub-token", b"\x00\xffprobe"),
                    ("/cursor/auth/exchange_user_api_key", None, "Bearer synthetic-hub-token", b"\x00\xffprobe"),
                ])
        finally:
            hub.shutdown()
            hub.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()

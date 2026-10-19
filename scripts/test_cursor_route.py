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
        with tempfile.TemporaryDirectory() as tmp:
            result = route.build_env(env, home=tmp)
            self.assertEqual(result["AGENT_CLI_CREDENTIAL_STORE"], "memory")
            self.assertNotEqual(result["CURSOR_CONFIG_DIR"], env["CURSOR_CONFIG_DIR"])
            config = Path(result["CURSOR_CONFIG_DIR"]) / "cli-config.json"
            self.assertTrue(json.loads(config.read_text())["network"]["useHttp1ForAgent"])

    def test_explicit_endpoint_cannot_bypass_pool(self):
        env = {"CURSOR_API_ENDPOINT": "http://pool.example/cursor"}
        for arguments in [["acp", "--agent-endpoint", "https://other.example"], ["-p", "prompt", "--agent-endpoint=https://other.example"]]:
            command = route.build_argv("cursor-agent", ["wrapper", *arguments], env)
            self.assertEqual(command[-2:], ["--agent-endpoint", env["CURSOR_API_ENDPOINT"]])
            self.assertFalse(any("other.example" in part for part in command))

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
    conn = http.client.HTTPConnection(url.hostname, url.port, timeout=10)
    conn.request("POST", "/" + path, body=b"\\x00\\xffprobe", headers={"Authorization": "Bearer synthetic-hub-token", "x-bb-cursor-rpc-path": "forged/path"})
    response = conn.getresponse()
    assert response.status == 200
    assert response.read() == b"\\x00\\xff\\x80end"
    conn.close()
print("PROBE_OK")
''')
                cli.chmod(0o755)
                env = dict(os.environ, HOME=tmp, PATH=tmp + os.pathsep + os.environ["PATH"], CURSOR_API_ENDPOINT=f"http://127.0.0.1:{hub.server_port}/cursor", CURSOR_POOL_RPC_GATEWAY="1", CURSOR_CONFIG_DIR=tmp)
                result = subprocess.run([sys.executable, str(WRAPPER), "acp"], env=env, capture_output=True, text=True, timeout=60)
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

    def test_jsonl_failure_roundtrip_through_gateway(self):
        class Hub(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                self.send_response(503)
                self.send_header('x-bb-pool-error', 'POOL_UPSTREAM_UNAVAILABLE')
                self.send_header('Content-Length', '0')
                self.end_headers()
        hub = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Hub)
        thread = threading.Thread(target=hub.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cli = Path(tmp) / 'cursor-agent'
                cli.write_text('#!' + sys.executable + '\n' + '''import http.client,json,os,sys
from urllib.parse import urlsplit
request=json.loads(sys.stdin.readline())
url=urlsplit(os.environ['CURSOR_API_ENDPOINT'])
conn=http.client.HTTPConnection(url.hostname,url.port,timeout=5)
conn.request('POST','/agent.v1.AgentService/Run',body=b'probe')
response=conn.getresponse();response.read();conn.close()
for text in ['Error: RetriableError: [unavailable] [POOL_', 'UPSTREAM_UNAVAILABLE] Synthetic failure']:
 print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':request['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}}),flush=True)
print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':{'stopReason':'end_turn'}}),flush=True)
''')
                cli.chmod(0o755)
                env=dict(os.environ, HOME=tmp, PATH=tmp+os.pathsep+os.environ['PATH'], CURSOR_API_ENDPOINT=f'http://127.0.0.1:{hub.server_port}/cursor', CURSOR_POOL_RPC_GATEWAY='1')
                request={'jsonrpc':'2.0','id':7,'method':'session/prompt','params':{'sessionId':'synthetic'}}
                try:
                    result=subprocess.run([sys.executable,'-c',
                        'import faulthandler,runpy,sys; faulthandler.dump_traceback_later(20); path=sys.argv[1]; sys.argv=sys.argv[1:]; runpy.run_path(path,run_name="__main__")',
                        str(WRAPPER),'acp'],input=json.dumps(request)+'\n',env=env,capture_output=True,text=True,timeout=60)
                except subprocess.TimeoutExpired as error:
                    self.fail('Synthetic ACP roundtrip stalled: '+str(error.stderr))
                self.assertEqual(result.returncode,0,result.stderr)
                messages=[json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(len(messages),3)
                self.assertEqual(messages[-1],{'jsonrpc':'2.0','id':7,'error':{'code':-32603,'message':'[POOL_UPSTREAM_UNAVAILABLE] Pooler connection temporarily unavailable.'}})
        finally:
            hub.shutdown();hub.server_close();thread.join()



class AcpFailureNormalizationTest(unittest.TestCase):
    def test_local_model_failure_becomes_failed_prompt_not_successful_answer(self):
        state=route.AcpPoolFailures()
        state.client({"id":1,"method":"session/prompt","params":{"sessionId":"synthetic"}})
        state.model_response('agent.v1.AgentService/Run','POOL_UPSTREAM_UNAVAILABLE')
        state.child({'method':'session/update','params':{'sessionId':'synthetic','update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':'Error: RetriableError: [unavailable] [POOL_UPSTREAM_UNAVAILABLE] Synthetic failure'}}}})
        result=state.child({"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}})
        self.assertNotIn('result',result)
        self.assertEqual(result['error']['code'],-32603)
        self.assertTrue(result['error']['message'].startswith('[POOL_UPSTREAM_UNAVAILABLE]'))

    def test_successful_retry_clears_old_failure_and_auxiliary_failures_are_ignored(self):
        state=route.AcpPoolFailures();state.client({"id":1,"method":"session/prompt","params":{}})
        state.model_response('agent.v1.AgentService/Run','POOL_UPSTREAM_UNAVAILABLE')
        state.model_response('agent.v1.AgentService/Run',None)
        original={"id":1,"result":{"stopReason":"end_turn"}}
        self.assertEqual(state.child(original),original)
        state.client({"id":2,"method":"session/prompt","params":{}})
        state.model_response('aiserver.v1.DashboardService/GetCurrentPeriodUsage','POOL_UPSTREAM_UNAVAILABLE')
        result={"id":2,"result":{"stopReason":"end_turn"}}
        self.assertEqual(state.child(result),result)

    def test_no_cross_session_guessing_or_arbitrary_error_propagation(self):
        state=route.AcpPoolFailures()
        for identifier in [1,2]:state.client({"id":identifier,"method":"session/prompt","params":{}})
        state.model_response('agent.v1.AgentService/Run','POOL_UPSTREAM_UNAVAILABLE')
        original={"id":1,"result":{"stopReason":"end_turn"}}
        self.assertEqual(state.child(original),original)
        state.model_response('agent.v1.AgentService/Run','private-secret')
        original={"id":2,"result":{"stopReason":"end_turn"}}
        self.assertEqual(state.child(original),original)

if __name__ == "__main__":
    unittest.main()

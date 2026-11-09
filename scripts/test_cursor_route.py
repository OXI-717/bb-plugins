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
from unittest import mock
import io

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

    def gateway_stream_case(self, mode, *, close_response=False, idle_seconds=0.7, header_deadline=0.3):
        import time
        import socket
        disconnected = []
        class Hub(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if mode == 'headers':
                    time.sleep(0.7)
                self.send_response(200)
                self.send_header('Transfer-Encoding', 'chunked')
                self.send_header('Connection', 'close' if close_response else 'keep-alive')
                self.end_headers()
                try:
                    self.wfile.write(b'3\r\nabc\r\n')
                    self.wfile.flush()
                    if mode == 'cancel':
                        started = time.monotonic()
                        self.connection.settimeout(3)
                        disconnected.append((self.connection.recv(1), time.monotonic() - started))
                        return
                    time.sleep(idle_seconds if mode == 'quiet' else 0)
                    payload = bytes(range(256)) * 12288 if mode == 'large' else b'def'
                    for offset in range(0, len(payload), 8191):
                        chunk = payload[offset:offset + 8191]
                        self.wfile.write(('%x\r\n' % len(chunk)).encode() + chunk + b'\r\n')
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                except (OSError, TimeoutError):
                    pass

        hub = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Hub)
        worker = threading.Thread(target=hub.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cli = Path(tmp) / 'cursor-agent'
                cli.write_text('#!' + sys.executable + '\n' + '''import http.client, os, time
from urllib.parse import urlsplit
u = urlsplit(os.environ['CURSOR_API_ENDPOINT'])
c = http.client.HTTPConnection(u.hostname, u.port, timeout=float(os.environ['STREAM_TIMEOUT']))
c.request('POST', '/agent.v1.AgentService/RunSSE', body=b'probe')
mode = os.environ['STREAM_CASE']
if mode == 'headers':
    try:
        c.getresponse()
    except http.client.RemoteDisconnected:
        print('HEADER_TIMEOUT_OK')
    else:
        raise AssertionError('Header deadline was removed')
else:
    r = c.getresponse()
    if mode == 'cancel':
        assert r.read(3) == b'abc'
        r.close()
        c.close()
        # Keep the process alive: process exit must not be what cancels upstream.
        time.sleep(2)
    else:
        expected = b'abc' + (bytes(range(256)) * 12288 if mode == 'large' else b'def')
        assert r.read() == expected
    print('STREAM_OK')
''')
                cli.chmod(0o755)
                env = dict(os.environ, HOME=tmp, PATH=tmp + os.pathsep + os.environ['PATH'],
                    CURSOR_API_ENDPOINT=f'http://127.0.0.1:{hub.server_port}/cursor',
                    CURSOR_POOL_RPC_GATEWAY='1', STREAM_CASE=mode, STREAM_TIMEOUT=str(idle_seconds + 10))
                # Scale only the wrapper's real socket deadline; the CLI keeps its own.
                bootstrap = "import http.client,runpy,sys; original=http.client.HTTPConnection; http.client.HTTPConnection=lambda *a,**kw:original(*a,**{**kw,'timeout':" + repr(header_deadline) + "}); path=sys.argv[1];sys.argv=sys.argv[1:];runpy.run_path(path,run_name='__main__')"
                command = [sys.executable, str(WRAPPER), 'acp'] if mode == 'cancel' else [sys.executable, '-c', bootstrap, str(WRAPPER), 'acp']
                result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=idle_seconds + 60)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), 'HEADER_TIMEOUT_OK' if mode == 'headers' else 'STREAM_OK')
                if mode == 'cancel':
                    self.assertEqual(len(disconnected), 1)
                    self.assertEqual(disconnected[0][0], b'')
                    self.assertLess(disconnected[0][1], 1.5)
        finally:
            hub.shutdown()
            hub.server_close()
            worker.join()

    def test_quiet_stream_survives_header_deadline(self):
        self.gateway_stream_case('quiet')

    def test_quiet_connection_close_stream_survives_header_deadline(self):
        self.gateway_stream_case('quiet', close_response=True)

    def test_header_deadline_is_still_enforced(self):
        self.gateway_stream_case('headers')

    def test_client_disconnect_cancels_quiet_upstream(self):
        self.gateway_stream_case('cancel')

    def test_large_response_preserves_every_byte(self):
        self.gateway_stream_case('large')

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


    def gateway_body_failure_case(self, mode):
        # A real socket cut, HTTP-clean partial Connect frame, or valid end frame.
        class Hub(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length', 0)))
                self.send_response(200)
                self.send_header('Content-Type', 'application/connect+proto')
                self.send_header('Transfer-Encoding', 'chunked')
                self.end_headers()
                payload = b'\x00\x00\x00\x00\x03abc'
                if mode in ('complete', 'after-end'):
                    payload += b'\x02\x00\x00\x00\x02{}'
                elif mode == 'partial':
                    payload += b'\x00\x00\x00'
                self.wfile.write(('%x\r\n' % len(payload)).encode() + payload + b'\r\n')
                self.wfile.flush()
                if mode == 'cancel':
                    self.connection.settimeout(5)
                    self.connection.recv(1)
                elif mode not in ('socket', 'after-end'):
                    self.wfile.write(b'0\r\n\r\n')
                    self.wfile.flush()
                self.close_connection = True
        hub = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Hub)
        worker = threading.Thread(target=hub.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                cli = Path(tmp) / 'cursor-agent'
                cli.write_text('#!' + sys.executable + '\n' + """import http.client,json,os,sys,time
from urllib.parse import urlsplit
r=json.loads(sys.stdin.readline())
u=urlsplit(os.environ['CURSOR_API_ENDPOINT'])
def update(text):
 print(json.dumps({'method':'session/update','params':{'sessionId':r['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'type':'text','text':text}}}}),flush=True)
update('Earlier normal output. ' * 40)
c=http.client.HTTPConnection(u.hostname,u.port,timeout=5)
c.request('POST','/agent.v1.AgentService/RunSSE',body=b'probe')
try:
 response=c.getresponse()
 if os.environ['BODY_MODE']=='cancel':
  response.read(3);response.close();c.close();time.sleep(0.6)
 else:
  response.read()
except (OSError,http.client.HTTPException):
 pass
c.close()
update('\\n\\nError: RetriableError: [invalid_argument] protocol error: incomplete envelope')
print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':{'stopReason':'end_turn'}}),flush=True)
""")
                cli.chmod(0o755)
                env = dict(os.environ, HOME=tmp, PATH=tmp+os.pathsep+os.environ['PATH'],
                    CURSOR_API_ENDPOINT=f'http://127.0.0.1:{hub.server_port}/cursor', CURSOR_POOL_RPC_GATEWAY='1', BODY_MODE=mode)
                result = subprocess.run([sys.executable, str(WRAPPER), 'acp'],
                    input=json.dumps({'id':7,'method':'session/prompt','params':{'sessionId':'synthetic'}})+'\n',
                    env=env,capture_output=True,text=True,timeout=60)
                self.assertEqual(result.returncode,0,result.stderr)
                messages=[json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(len(messages),3)
                if mode in ('complete', 'after-end', 'cancel'):
                    # Error-like assistant text alone cannot turn success into failure.
                    self.assertEqual(messages[-1],{'jsonrpc':'2.0','id':7,'result':{'stopReason':'end_turn'}})
                else:
                    self.assertEqual(messages[-1],{'jsonrpc':'2.0','id':7,'error':{'code':-32603,'message':'[POOL_UPSTREAM_UNAVAILABLE] Pooler connection temporarily unavailable.'}})
        finally:
            hub.shutdown();hub.server_close();worker.join()

    def test_socket_cut_becomes_failed_prompt_after_normal_output(self):
        self.gateway_body_failure_case('socket')

    def test_http_clean_partial_connect_frame_becomes_failed_prompt(self):
        self.gateway_body_failure_case('partial')

    def test_http_clean_missing_connect_end_becomes_failed_prompt(self):
        self.gateway_body_failure_case('missing-end')

    def test_complete_connect_stream_keeps_success(self):
        self.gateway_body_failure_case('complete')

    def test_client_disconnect_does_not_become_a_retryable_model_failure(self):
        self.gateway_body_failure_case('cancel')

    def test_socket_cut_after_complete_connect_end_keeps_success(self):
        self.gateway_body_failure_case('after-end')



class AcpFailureNormalizationTest(unittest.TestCase):
    def test_child_eof_stops_reader_while_parent_input_remains_open(self):
        read_fd, write_fd = os.pipe()
        before = set(threading.enumerate())
        process = mock.Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
        incoming = os.fdopen(read_fd, 'rb')
        try:
            with mock.patch.object(sys, 'stdin', mock.Mock(buffer=incoming, fileno=incoming.fileno)):
                route.relay_acp(process, route.AcpPoolFailures())
                readers = [t for t in threading.enumerate() if t not in before]
                self.assertEqual(readers, [], 'ACP reader survives child EOF')
        finally:
            os.close(write_fd)
            for reader in set(threading.enumerate()) - before:
                reader.join(timeout=1)
            incoming.close()

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

    def test_interrupted_request_is_not_carried_into_a_fresh_model_request(self):
        state=route.AcpPoolFailures()
        state.client({'id':1,'method':'session/prompt','params':{'sessionId':'synthetic'}})
        old=state.begin_model_request('agent.v1.AgentService/RunSSE')
        state.model_interrupted(old)
        fresh=state.begin_model_request('agent.v1.AgentService/RunSSE')
        state.model_interrupted(old)  # A late old read cannot fail the fresh request.
        state.model_response('agent.v1.AgentService/RunSSE',None,fresh)
        original={'id':1,'result':{'stopReason':'end_turn'}}
        self.assertEqual(state.child(original),original)

    def test_interruption_is_not_carried_across_ambiguous_prompts_or_reused_ids(self):
        state=route.AcpPoolFailures()
        state.client({'id':1,'method':'session/prompt','params':{}})
        old=state.begin_model_request('agent.v1.AgentService/RunSSE')
        state.client({'id':2,'method':'session/prompt','params':{}})
        state.model_interrupted(old)
        for identifier in (2,1):
            original={'id':identifier,'result':{'stopReason':'end_turn'}}
            self.assertEqual(state.child(original),original)
        state.client({'id':1,'method':'session/prompt','params':{}})
        state.model_interrupted(old)
        original={'id':1,'result':{'stopReason':'end_turn'}}
        self.assertEqual(state.child(original),original)

    def test_interruption_does_not_replace_cancellation_or_existing_rpc_errors(self):
        for result in ({'result':{'stopReason':'cancelled'}},{'error':{'code':-1,'message':'synthetic'}}):
            state=route.AcpPoolFailures()
            state.client({'id':1,'method':'session/prompt','params':{}})
            state.model_interrupted(state.begin_model_request('agent.v1.AgentService/RunPoll'))
            original={'id':1,**result}
            self.assertEqual(state.child(original),original)

    def test_connect_completion_observes_fragmented_headers_and_large_payload_without_retaining_it(self):
        state=route.ConnectCompletion()
        payload=b'x'*(3*1024*1024)
        wire=b'\x01'+len(payload).to_bytes(4,'big')+payload+b'\x02\x00\x00\x00\x02{}'
        for offset in range(0,len(wire),8191):
            state.feed(wire[offset:offset+8191])
            self.assertLessEqual(len(state.header),4)
        self.assertTrue(state.complete)
        for boundary in range(1,12):
            state=route.ConnectCompletion()
            terminal=b'\x02\x00\x00\x00\x02{}'
            for byte in terminal[:boundary]:
                state.feed(bytes([byte]))
            self.assertEqual(state.complete,boundary>=len(terminal))

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

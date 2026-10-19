#!/usr/bin/env python3
"""Launch Cursor's ACP agent so that a pooled session cannot leak past the hub.

BB's built-in `acp-cursor` spawns `cursor-agent acp` with fixed arguments, and that is
not enough when the Account Pooler routes the provider. Cursor takes the address of its
agent stream from the server config it fetches, so a hub that faithfully proxies that
response hands the CLI Cursor's own address and the stream goes straight there —
carrying the machine's pool token, which Cursor rejects. The visible symptom is an agent
that answers `Please sign in to continue` while every other call succeeded.

`--agent-endpoint` outranks the server-supplied address, so this wrapper passes it
whenever the hub gave us one. Without `CURSOR_API_ENDPOINT` the wrapper is transparent:
the CLI runs on its own local login exactly as before.

Install: copy onto PATH as `cursor-route` — BB spawns custom agents with a bare
command and no shell, so `~` in its configuration would not expand.
"""
import os
from pathlib import Path
import shutil
import sys
import http.client
import http.server
import signal
import subprocess
import threading
import json
import re
from urllib.parse import urlsplit

CURSOR_BINARY = "cursor-agent"
ENDPOINT_VAR = "CURSOR_API_ENDPOINT"
CONFIG_DIR_VAR = "CURSOR_CONFIG_DIR"
#: Config the pooled session needs: the agent stream defaults to HTTP/2, which the hub
#: does not speak, and the CLI then fails the turn with "[internal] Protocol error".
POOLED_CONFIG = '{"network":{"useHttp1ForAgent":true}}'
POOLED_CONFIG_DIR = ".local/state/oxi-cursor-route"


class AcpPoolFailures:
    """Normalize a known local model refusal which Cursor prints as an answer.

    Only one active ACP prompt can be attributed to an outgoing model request.
    Auxiliary HTTP errors, ambiguous concurrent prompts and arbitrary messages
    never become failed turns. No request body or credential is retained.
    """
    REASONS = frozenset({'POOL_UPSTREAM_UNAVAILABLE', 'VPN_REQUIRED',
                         'VPN_GUARD_BLOCKED', 'VPN_GUARD_UNAVAILABLE'})

    def __init__(self):
        self.lock = threading.Lock()
        self.pending = {}
        self.generation = 0

    def client(self, message):
        if not isinstance(message, dict) or message.get('method') != 'session/prompt':
            return
        identifier = message.get('id')
        if type(identifier) not in (str, int):
            return
        with self.lock:
            if len(self.pending) < 64:
                self.generation += 1
                params = message.get('params') or {}
                self.pending[identifier] = {'generation': self.generation,
                    'session': params.get('sessionId') if isinstance(params, dict) else None,
                    'reason': None, 'reported': False, 'prefix': ''}

    def begin_model_request(self, path):
        if not re.fullmatch(r'agent\.v[0-9]+\.AgentService/Run(?:SSE|Poll)?', path):
            return None
        with self.lock:
            if len(self.pending) != 1:
                return None
            identifier = next(iter(self.pending))
            self.pending[identifier].update(reason=None, reported=False, prefix='')
            return (identifier, self.pending[identifier]['generation'])

    def model_response(self, path, reason, prompt=None):
        token = prompt if prompt is not None else self.begin_model_request(path)
        if token is None:
            return
        with self.lock:
            current = self.pending.get(token[0])
            if current and current['generation'] == token[1]:
                current['reason'] = reason if reason in self.REASONS else None

    def child(self, message):
        if not isinstance(message, dict):
            return message
        with self.lock:
            if message.get('method') == 'session/update':
                params = message.get('params') or {}
                update = params.get('update', {}) if isinstance(params, dict) else {}
                content = update.get('content', {}) if isinstance(update, dict) else {}
                text = content.get('text') if isinstance(content, dict) else None
                if isinstance(update, dict) and update.get('sessionUpdate') == 'agent_message_chunk' and isinstance(text, str):
                    for current in self.pending.values():
                        if params.get('sessionId') != current['session']:
                            continue
                        current['prefix'] = (current['prefix'] + text[:256])[:256]
                        match = re.match(r'^(?:Error: )?(?:RetriableError: )?\[(?:unavailable|permission_denied)\] \[([A-Z_]+)\]', current['prefix'])
                        if match and match[1] == current['reason']:
                            current['reported'] = True
            identifier = message.get('id')
            if type(identifier) not in (str, int) or ('result' not in message and 'error' not in message):
                return message
            current = self.pending.pop(identifier, None)
            if current and current['reason'] and current['reported'] and isinstance(message.get('result'), dict) and message['result'].get('stopReason') == 'end_turn':
                reason = current['reason']
                return {'jsonrpc': '2.0', 'id': identifier, 'error': {
                    'code': -32603, 'message': '[' + reason + '] Pooler connection temporarily unavailable.'}}
        return message


def relay_acp(process, failures):
    """Preserve JSONL traffic except an explicitly correlated failed prompt."""
    def parse(line):
        if len(line) > 1024 * 1024:
            return None
        try:
            return json.loads(line)
        except (ValueError, UnicodeError):
            return None

    def incoming():
        try:
            while True:
                line = sys.stdin.buffer.readline(1024 * 1024 + 1)
                if not line:
                    break
                message = parse(line)
                if message is not None:
                    failures.client(message)
                process.stdin.write(line)
                process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
    threading.Thread(target=incoming, daemon=True).start()
    while True:
        line = process.stdout.readline(1024 * 1024 + 1)
        if not line:
            break
        message = parse(line)
        transformed = failures.child(message) if message is not None else message
        if transformed is not message:
            line = json.dumps(transformed, separators=(',', ':')).encode() + b'\n'
        sys.stdout.buffer.write(line)
        sys.stdout.buffer.flush()


def build_argv(executable, argv, env):
    """Command line for the CLI: the caller's arguments plus the hub's agent endpoint."""
    passthrough = list(argv[1:]) or ["acp"]
    endpoint = (env.get(ENDPOINT_VAR) or "").strip()
    if not endpoint:
        return [executable, *passthrough]
    # Pooled auth must never go to a caller-supplied upstream endpoint.
    filtered = []
    arguments = iter(passthrough)
    for argument in arguments:
        if argument == "--agent-endpoint":
            next(arguments, None)
        elif not argument.startswith("--agent-endpoint="):
            filtered.append(argument)
    passthrough = filtered
    return [executable, *passthrough, "--agent-endpoint", endpoint]


def pooled_config_dir(env, home=None):
    """Config directory for a pooled session, created on demand.

    Kept apart from the machine's own `~/.cursor` so the wrapper never edits settings the
    user owns. Pooled sessions always use this directory to guarantee HTTP/1.
    """
    base = Path(home) if home is not None else Path.home()
    directory = base / POOLED_CONFIG_DIR
    directory.mkdir(parents=True, exist_ok=True)
    config = directory / "cli-config.json"
    if not config.exists() or config.read_text(encoding="utf-8") != POOLED_CONFIG:
        config.write_text(POOLED_CONFIG, encoding="utf-8")
    return directory


def build_env(env, home=None):
    """Environment for the CLI: pooled sessions get the HTTP/1 agent config."""
    result = dict(env)
    if not (result.get(ENDPOINT_VAR) or "").strip():
        return result
    # CURSOR_CONFIG_DIR does not namespace macOS Keychain. The CLI persists API-key
    # auth there and can clear it on rejection, replacing the user's normal login.
    # Pooled auth must remain ephemeral, including when callers provide a config dir.
    result["AGENT_CLI_CREDENTIAL_STORE"] = "memory"
    result[CONFIG_DIR_VAR] = str(pooled_config_dir(result, home))
    return result


def main(argv=None):
    argv = list(sys.argv if argv is None else argv)
    executable = shutil.which(CURSOR_BINARY)
    if not executable:
        sys.exit(f"{CURSOR_BINARY} executable unavailable")
    env = build_env(os.environ)
    if env.get("CURSOR_POOL_RPC_GATEWAY") == "1" and env.get(ENDPOINT_VAR):
        run_gateway(executable, argv, env)
        return
    command = build_argv(executable, argv, env)
    os.execve(command[0], command, env)


def run_gateway(executable, argv, env):
    """Translate arbitrary Cursor RPC paths to BB's one exact gateway route."""
    target = urlsplit(env[ENDPOINT_VAR].rstrip("/"))
    if target.scheme not in ("http", "https") or not target.hostname or target.query or target.fragment or target.username:
        raise SystemExit("Invalid Cursor pool endpoint")
    failures = AcpPoolFailures()

    class Handler(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # Never log requests, tokens, bodies or credentials to ACP stdout.

        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            self.forward()

        def do_POST(self):
            self.forward()

        def forward(self):
            parsed = urlsplit(self.path)
            rpc_path = parsed.path.lstrip("/")
            if parsed.query or parsed.scheme or parsed.netloc or not rpc_path:
                self.send_error(400, "Invalid RPC path")
                return
            connection = None
            prompt = failures.begin_model_request(rpc_path)
            try:
                limit = 16 * 1024 * 1024
                if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                    chunks, size = [], 0
                    while True:
                        n = int(self.rfile.readline(128).strip().split(b";")[0], 16)
                        if n < 0 or size + n > limit:
                            self.send_error(413)
                            return
                        if not n:
                            while self.rfile.readline(8192).strip():
                                pass
                            break
                        chunks.append(self.rfile.read(n))
                        size += n
                        self.rfile.read(2)
                    body = b"".join(chunks)
                else:
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 0 or length > limit:
                        self.send_error(413)
                        return
                    body = self.rfile.read(length)
                headers = {k: v for k, v in self.headers.items() if k.lower() not in {
                    "host", "connection", "content-length", "transfer-encoding", "x-bb-cursor-rpc-path"}}
                if rpc_path == "auth/exchange_user_api_key":
                    path = target.path + "/" + rpc_path
                else:
                    path = target.path + "/rpc"
                    headers["x-bb-cursor-rpc-path"] = rpc_path
                connection_type = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
                connection = connection_type(target.hostname, target.port, timeout=120)
                connection.request(self.command, path, body=body, headers=headers)
                response = connection.getresponse()
                if prompt is not None:
                    failures.model_response(rpc_path, response.getheader('x-bb-pool-error'), prompt)
                self.send_response(response.status)
                for k, v in response.getheaders():
                    if k.lower() not in {"content-length", "connection", "transfer-encoding"}:
                        self.send_header(k, v)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = response.read1(8192)
                    if not chunk:
                        break
                    self.wfile.write(("%x\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                if not self.wfile.closed:
                    # Keep ACP stdout exclusively for the child protocol.
                    print("Cursor pool gateway connection failed", file=sys.stderr)
                self.close_connection = True
            finally:
                if connection:
                    connection.close()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    local_env = dict(env)
    local_env[ENDPOINT_VAR] = "http://127.0.0.1:%d" % server.server_port
    command = build_argv(executable, argv, local_env)
    acp = not argv[1:] or argv[1] == 'acp'
    process = subprocess.Popen(command, env=local_env,
        **({'stdin': subprocess.PIPE, 'stdout': subprocess.PIPE} if acp else {}))
    def stop(signum, _frame):
        process.send_signal(signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        if acp:
            relay_acp(process, failures)
        code = process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        server.shutdown()
        server.server_close()
    raise SystemExit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()

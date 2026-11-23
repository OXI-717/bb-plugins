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
import select
import socket
import time
import stat
from collections import deque
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
        self.model_streams = {}
        self.generation = 0
        self.request_generation = 0
        self.trace = deque(maxlen=64)
        self.trace_sequence = 0
        self.trace_dumps = 0
        self.observed_error = False

    def note(self, event, **fields):
        # Callers supply fixed enums, booleans, counters and validated pool UUIDs.
        # Never pass protocol dictionaries, text, URLs or exception messages.
        self.trace_sequence += 1
        self.trace.append(dict(seq=self.trace_sequence, atMs=int(time.monotonic()*1000),
                               event=event, **fields))

    def dump_trace(self, trigger):
        if self.trace_dumps >= 3:
            return
        self.trace_dumps += 1
        snapshot = json.dumps(dict(trigger=trigger, events=list(self.trace)), separators=(',', ':'))
        if sys.stderr is not None:
            try:
                print('Cursor pool diagnostic ' + snapshot, file=sys.stderr, flush=True)
            except (OSError, ValueError):
                pass
        # ACP keeps stderr in memory until process exit. Preserve bounded metadata
        # in the existing thread storage too; failures never alter the protocol.
        storage = os.environ.get('BB_THREAD_STORAGE')
        if not storage or os.name != 'posix':
            return
        directory = descriptor = None
        try:
            import fcntl
            directory = os.open(storage, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptor = os.open('cursor-pool-diagnostics.jsonl', os.O_WRONLY | os.O_APPEND |
                os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            info = os.fstat(descriptor)
            encoded = (snapshot + '\n').encode()
            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_size + len(encoded) <= 1024*1024:
                os.fchmod(descriptor, 0o600)
                os.write(descriptor, encoded)
        except (OSError, ImportError):
            pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if directory is not None:
                os.close(directory)

    def body_trace(self, token, pool_id, outcome, completion, count):
        with self.lock:
            current = self.pending.get(token[0]) if token else None
            matches = bool(current and (current['generation'], current['request']) == token[1:])
            self.note('body_end', poolRequestId=pool_id, tokenPresent=token is not None,
                currentMatch=matches, pendingCount=len(self.pending), outcome=outcome,
                bytesRead=count, complete=bool(completion and completion.complete),
                remaining=completion.remaining if completion else 0,
                headerLength=len(completion.header) if completion else 0)
            if outcome == 'read_error':
                self.dump_trace('read_error')

    def _release_generation(self, generation):
        # Called under the state lock. Socket shutdown does not wait for readers.
        owned = [key for key, (owner, _) in self.model_streams.items() if owner == generation]
        for key in owned:
            _, close = self.model_streams.pop(key)
            try:
                close()
            except Exception:
                pass

    def register_model_stream(self, token, close):
        if token is None:
            return None
        with self.lock:
            current = self.pending.get(token[0])
            if not current or current['generation'] != token[1]:
                close()
                return None
            if len(self.model_streams) >= 64:
                return None
            key = object()
            self.model_streams[key] = (token[1], close)
            return key

    def unregister_model_stream(self, key):
        with self.lock:
            self.model_streams.pop(key, None)

    def client(self, message):
        if not isinstance(message, dict):
            return
        if message.get('method') == 'session/cancel':
            params = message.get('params')
            session = params.get('sessionId') if isinstance(params, dict) else None
            if isinstance(session, str):
                with self.lock:
                    for current in self.pending.values():
                        if current['session'] == session:
                            self._release_generation(current['generation'])
                    self.pending = {identifier: current for identifier, current in self.pending.items()
                        if current['session'] != session}
                    self.note('cancel', pendingCount=len(self.pending))
            return
        if message.get('method') != 'session/prompt':
            return
        identifier = message.get('id')
        if type(identifier) not in (str, int):
            return
        with self.lock:
            self.note('prompt', pendingCount=len(self.pending))
            if len(self.pending) < 64:
                self.generation += 1
                params = message.get('params') or {}
                ambiguous = identifier in self.pending
                self.pending[identifier] = {'generation': self.generation, 'ambiguous': ambiguous,
                    'session': params.get('sessionId') if isinstance(params, dict) else None,
                    'reason': None, 'reported': False, 'prefix': '',
                    'request': None, 'interrupted': False}
                if len(self.pending) > 1:
                    # No HTTP-to-prompt attribution survives ambiguous prompts.
                    for current in self.pending.values():
                        current.update(request=None, reason=None, reported=False, interrupted=False)

    def begin_model_request(self, path):
        if not re.fullmatch(r'agent\.v[0-9]+\.AgentService/Run(?:SSE|Poll)?', path):
            return None
        with self.lock:
            self.note('model_open', pendingCount=len(self.pending), requestGeneration=self.request_generation)
            if len(self.pending) != 1:
                return None
            identifier = next(iter(self.pending))
            self.request_generation += 1
            self.pending[identifier].update(reason=None, reported=False, prefix='',
                request=self.request_generation, interrupted=False)
            return (identifier, self.pending[identifier]['generation'], self.request_generation)

    def model_response(self, path, reason, prompt=None):
        token = prompt if prompt is not None else self.begin_model_request(path)
        if token is None:
            return
        with self.lock:
            current = self.pending.get(token[0])
            if current and (current['generation'], current['request']) == token[1:]:
                current['reason'] = reason if reason in self.REASONS else None

    def model_interrupted(self, token):
        if token is None:
            return
        with self.lock:
            current = self.pending.get(token[0])
            if current and (current['generation'], current['request']) == token[1:]:
                current.update(reason='POOL_UPSTREAM_UNAVAILABLE', interrupted=True)
                self.note('interruption', applied=True)
            else:
                self.note('interruption', applied=False, tokenPresent=token is not None)

    def child(self, message):
        if not isinstance(message, dict):
            return message
        with self.lock:
            if message.get('method') == 'session/update':
                params = message.get('params') or {}
                update = params.get('update', {}) if isinstance(params, dict) else {}
                content = update.get('content', {}) if isinstance(update, dict) else {}
                text = content.get('text') if isinstance(content, dict) else None
                if isinstance(text, str) and text.strip().startswith(('Error: RetriableError: Stream ended without turnEnded', 'Error: RetriableError: [invalid_argument] protocol error: incomplete envelope')):
                    self.observed_error = True
                    self.note('known_transport_text')
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
            if current and not current['ambiguous']:
                self._release_generation(current['generation'])
            self.note('reply', pendingMatch=current is not None, interrupted=bool(current and current['interrupted']), hasError='error' in message)
            if self.observed_error:
                self.dump_trace('known_transport_text')
                self.observed_error = False
            rpc_error = message.get('error')
            interrupted_rpc = (isinstance(rpc_error, dict) and rpc_error.get('code') == -32603
                and isinstance(rpc_error.get('message'), str) and re.fullmatch(
                    r'(?:Internal error: )?(?:Error: )?(?:RetriableError: )?(?:\[invalid_argument\] protocol error: incomplete envelope|Stream ended without turnEnded — connection likely dropped mid-stream|\[aborted\] socket hang up)',
                    rpc_error['message'].strip()) is not None)
            false_success = isinstance(message.get('result'), dict) and message['result'].get('stopReason') == 'end_turn'
            if current and current['reason'] and (current['reported'] or current['interrupted']) and (false_success or (current['interrupted'] and interrupted_rpc)):
                reason = current['reason']
                return {'jsonrpc': '2.0', 'id': identifier, 'error': {
                    'code': -32603, 'message': '[' + reason + '] Pooler connection temporarily unavailable.'}}
        return message


class ConnectCompletion:
    """Observe envelope boundaries without retaining model payloads or changing bytes."""
    def __init__(self):
        self.header = bytearray()
        self.remaining = 0
        self.end = False
        self.complete = False

    def feed(self, chunk):
        offset = 0
        while offset < len(chunk):
            if self.remaining:
                take = min(self.remaining, len(chunk) - offset)
                self.remaining -= take
                offset += take
                if not self.remaining and self.end:
                    self.complete = True
            else:
                take = min(5 - len(self.header), len(chunk) - offset)
                self.header.extend(chunk[offset:offset + take])
                offset += take
                if len(self.header) == 5:
                    self.end = bool(self.header[0] & 2)
                    self.remaining = int.from_bytes(self.header[1:], 'big')
                    self.header.clear()
                    if not self.remaining and self.end:
                        self.complete = True


def relay_acp(process, failures):
    """Preserve JSONL traffic except an explicitly correlated failed prompt."""
    stopped = threading.Event()
    input_fd = sys.stdin.fileno()
    def parse(line):
        if len(line) > 1024 * 1024:
            with failures.lock:
                failures.note('parse_too_large', bytesRead=len(line))
            return None
        try:
            return json.loads(line)
        except (ValueError, UnicodeError):
            return None

    def incoming():
        pending = bytearray()
        limit = 1024 * 1024 + 1

        def forward(line):
            message = parse(line)
            if message is not None:
                failures.client(message)
            process.stdin.write(line)
            process.stdin.flush()

        try:
            while not stopped.is_set():
                if not select.select([input_fd], [], [], 0.1)[0]:
                    continue
                chunk = os.read(input_fd, 65536)
                if not chunk:
                    if pending:
                        forward(bytes(pending))
                    break
                pending.extend(chunk)
                while pending:
                    newline = pending.find(b'\n', 0, limit)
                    if newline < 0 and len(pending) < limit:
                        break
                    length = newline + 1 if newline >= 0 else limit
                    forward(bytes(pending[:length]))
                    del pending[:length]
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except OSError:
                pass
    reader = threading.Thread(target=incoming, daemon=True)
    reader.start()
    try:
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
    finally:
        stopped.set()
        reader.join(timeout=1)


def is_acp_invocation(argv):
    """Recognize ACP after known global options, without changing CLI arguments."""
    arguments = iter(argv[1:])
    if not argv[1:]:
        return True
    for argument in arguments:
        if argument in ('--model', '--agent-endpoint'):
            if next(arguments, None) is None:
                return False
        elif argument.startswith(('--model=', '--agent-endpoint=')):
            continue
        elif argument in ('--use-system-ca', '--no-use-system-ca'):
            continue
        else:
            # Unknown options and other commands keep the original CLI I/O path.
            return argument == 'acp'
    return False


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


def watch_client_disconnect(client, upstream, stopped, disconnected=None):
    """Cancel a quiet upstream when its local consumer disappears."""
    while not stopped.wait(0.25):
        try:
            if not select.select([client], [], [], 0)[0]:
                continue
            # Peek only: a subsequent HTTP request must remain untouched.
            if client.recv(1, socket.MSG_PEEK):
                continue
        except (OSError, ValueError):
            pass
        if disconnected is not None:
            disconnected.set()
        try:
            upstream.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        return


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
            watcher = None
            stream_key = None
            stopped = threading.Event()
            disconnected = threading.Event()
            prompt = failures.begin_model_request(rpc_path)
            pool_id = None
            completion = None
            bytes_read = 0
            body_outcome = None
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
                # Keep the deadline for connecting and receiving headers only.
                # getresponse() can detach this socket for Connection: close.
                upstream_socket = connection.sock
                def close_owned_stream():
                    disconnected.set()
                    try:
                        upstream_socket.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                stream_key = failures.register_model_stream(prompt, close_owned_stream)
                response = connection.getresponse()
                if prompt is not None:
                    failures.model_response(rpc_path, response.getheader('x-bb-pool-error'), prompt)
                raw_pool_id = response.getheader('x-bb-pool-request-id', '')
                pool_id = raw_pool_id if re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', raw_pool_id) else None
                with failures.lock:
                    if prompt is not None or re.fullmatch(r'agent\.v[0-9]+\.AgentService/Run(?:SSE|Poll)?', rpc_path):
                        failures.note('model_headers', poolRequestId=pool_id, tokenPresent=prompt is not None, pendingCount=len(failures.pending))
                content_type = response.getheader('content-type', '').split(';')[0].strip().lower()
                completion = ConnectCompletion() if content_type in {
                    'application/connect+proto', 'application/connect+json', 'text/event-stream'} else None
                self.send_response(response.status)
                for k, v in response.getheaders():
                    if k.lower() not in {"content-length", "connection", "transfer-encoding"}:
                        self.send_header(k, v)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                # Cursor streams can be quiet while a model or tool is running.
                # Their lifetime follows the consumer rather than a read timer.
                upstream_socket.settimeout(None)
                watcher = threading.Thread(target=watch_client_disconnect,
                    args=(self.connection, upstream_socket, stopped, disconnected), daemon=True)
                watcher.start()
                while True:
                    try:
                        chunk = response.read1(8192)
                    except (OSError, http.client.HTTPException):
                        body_outcome = 'downstream_disconnect' if disconnected.is_set() else 'read_error'
                        if response.status == 200 and not disconnected.is_set() and not (completion and completion.complete):
                            failures.model_interrupted(prompt)
                        raise
                    if not chunk:
                        body_outcome = 'downstream_disconnect' if disconnected.is_set() else 'eof'
                        if response.status == 200 and completion and not completion.complete and not disconnected.is_set():
                            failures.model_interrupted(prompt)
                        break
                    bytes_read += len(chunk)
                    if completion:
                        completion.feed(chunk)
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
                failures.unregister_model_stream(stream_key)
                if body_outcome and re.fullmatch(r'agent\.v[0-9]+\.AgentService/Run(?:SSE|Poll)?', rpc_path):
                    failures.body_trace(prompt, pool_id, body_outcome, completion, bytes_read)
                stopped.set()
                if watcher:
                    watcher.join(timeout=1)
                if connection:
                    connection.close()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    local_env = dict(env)
    local_env[ENDPOINT_VAR] = "http://127.0.0.1:%d" % server.server_port
    command = build_argv(executable, argv, local_env)
    acp = is_acp_invocation(argv)
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

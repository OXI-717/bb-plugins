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
from urllib.parse import urlsplit

CURSOR_BINARY = "cursor-agent"
ENDPOINT_VAR = "CURSOR_API_ENDPOINT"
CONFIG_DIR_VAR = "CURSOR_CONFIG_DIR"
#: Config the pooled session needs: the agent stream defaults to HTTP/2, which the hub
#: does not speak, and the CLI then fails the turn with "[internal] Protocol error".
POOLED_CONFIG = '{"network":{"useHttp1ForAgent":true}}'
POOLED_CONFIG_DIR = ".local/state/oxi-cursor-route"


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
    process = subprocess.Popen(command, env=local_env)
    def stop(signum, _frame):
        process.send_signal(signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        code = process.wait()
    finally:
        server.shutdown()
        server.server_close()
    raise SystemExit(code if code >= 0 else 128 - code)


if __name__ == "__main__":
    main()

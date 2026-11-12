#!/usr/bin/env python3
"""OXI Op broker: runs 1Password CLI calls for the Oxi Op plugin inside one long-lived service.

Why: an `op` call started by the BB plugin host is attributed by macOS to its parent
("node"), and a wrapper app started from BB is not remembered for app-data access,
so every call raised a new prompt. This broker runs as a launchd service wrapped in a
named app by oxi-launchd ("OXI Op Broker"); `op` runs as its child, so macOS asks once
for the app and 1Password keeps one authorisation for the service instead of one per
call.

Protocol: the plugin connects to a Unix socket in a 0700 directory owned by the user,
sends one JSON line {"args": [...], "stdin": "<base64>"} and receives one JSON line
{"code": int, "stdout": "<base64>"}. Standard error is never returned. Only reading and
managing items, vaults and service accounts is allowed; `op run`, plugins, signin and
any other command are refused, so the broker cannot be used to start programs.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import select
import signal
import socket
import socketserver
import stat
import subprocess
import sys
import threading
import time

MAX_REQUEST = 4 * 1024 * 1024
MAX_OUTPUT = 4 * 1024 * 1024
TIMEOUT = 90
ALLOWED = {
    "item": {"list", "get", "create", "edit", "delete", "move", "template"},
    "vault": {"list", "get", "create", "delete"},
    "document": {"create", "get"},
    "read": None,
    "service-account": {"create"},
    "account": {"list", "get"},
    "whoami": None,
}


def allowed(args: list[str]) -> bool:
    """`--account <id>` followed by an allowed command group and subcommand."""
    if len(args) < 3 or args[0] != "--account" or not args[1] or args[1].startswith("-"):
        return False
    group = args[2]
    if group not in ALLOWED:
        return False
    subcommands = ALLOWED[group]
    if subcommands is None:
        return True
    return len(args) > 3 and args[3] in subcommands


def child_env() -> dict[str, str]:
    """Desktop (biometric) authorisation only: never a service-account or session token."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("OP_")}
    env["OP_BIOMETRIC_UNLOCK_ENABLED"] = "true"
    return env


class Handler(socketserver.StreamRequestHandler):
    op_binary = "op"

    def handle(self) -> None:
        line = self.rfile.readline(MAX_REQUEST + 1)
        try:
            if len(line) > MAX_REQUEST:
                raise ValueError("request too large")
            request = json.loads(line)
            args = request["args"]
            if not isinstance(args, list) or not all(isinstance(a, str) and "\0" not in a for a in args):
                raise ValueError("args")
            data = base64.b64decode(request.get("stdin", ""), validate=True)
        except (ValueError, KeyError, TypeError):
            self.reply({"code": 2, "error": "bad-request"})
            return
        if not allowed(args):
            self.reply({"code": 2, "error": "not-allowed"})
            return
        # op treats a FIFO on stdin as a piped item template: an empty pipe breaks `item edit` and a
        # pipe next to `--template /dev/stdin` breaks `item create`. Input therefore arrives on a
        # socket, as it does from the BB host process, and a call without input gets /dev/null.
        feed = child = None
        try:
            if data:
                feed, child = socket.socketpair()
            proc = subprocess.Popen([self.op_binary, *args], stdin=child.fileno() if child else subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=child_env(), start_new_session=False)
        except OSError:
            for end in (feed, child):
                if end:
                    end.close()
            self.reply({"code": 127, "error": "spawn-failed"})
            return
        finally:
            if child:
                child.close()

        def run() -> None:
            if feed:
                try:
                    feed.sendall(data)
                    feed.shutdown(socket.SHUT_WR)
                except OSError:
                    pass
                finally:
                    feed.close()
            result.update(out=proc.communicate()[0])

        # The caller keeps its side open while it waits; a closed connection means it cancelled,
        # and the command must stop before it can finish a change nobody is waiting for.
        result: dict = {}
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        deadline = time.monotonic() + TIMEOUT
        while worker.is_alive():
            if time.monotonic() > deadline:
                proc.kill()
                worker.join()
                self.reply({"code": 124, "error": "timeout"})
                return
            readable, _, _ = select.select([self.connection], [], [], 0.1)
            if readable:
                try:
                    gone = self.connection.recv(1, socket.MSG_PEEK) == b""
                except OSError:
                    gone = True
                if gone:
                    proc.kill()
                    worker.join()
                    return
            worker.join(0)
        out = result.get("out", b"")
        if len(out) > MAX_OUTPUT:
            self.reply({"code": 2, "error": "output-too-large"})
            return
        self.reply({"code": proc.returncode, "stdout": base64.b64encode(out).decode("ascii")})

    def reply(self, payload: dict) -> None:
        try:
            self.wfile.write(json.dumps(payload).encode("utf-8") + b"\n")
        except OSError:
            pass


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def verify_request(self, request, client_address) -> bool:  # type: ignore[override]
        # Only processes of the same user may use the broker (macOS LOCAL_PEERCRED).
        try:
            if sys.platform == "darwin":
                import struct
                cred = request.getsockopt(0, 0x001, struct.calcsize("IIh16I"))
                uid = struct.unpack_from("IIh", cred)[1]
            else:
                pid, uid, gid = __import__("struct").unpack("3i", request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            return uid == os.getuid()
        except OSError:
            return False


def prepare_socket(path: str) -> None:
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    info = os.stat(directory)
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        os.chmod(directory, 0o700)
    if os.path.exists(path):
        os.unlink(path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="OXI Op broker for 1Password CLI calls")
    parser.add_argument("--op", required=True, help="absolute path of the op binary")
    parser.add_argument("--socket", required=True, help="absolute path of the broker socket")
    args = parser.parse_args(argv)
    if not os.path.isabs(args.op) or not os.path.isabs(args.socket):
        parser.error("paths must be absolute")
    Handler.op_binary = args.op
    prepare_socket(args.socket)
    old = os.umask(0o177)
    try:
        server = Server(args.socket, Handler)
    finally:
        os.umask(old)
    os.chmod(args.socket, 0o600)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            os.unlink(args.socket)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

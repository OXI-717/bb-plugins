#!/usr/bin/env python3
"""Read distributed application defaults, never a user's authorization profile.

Used only by an explicit server-side login. Output is private process data;
callers must not log it or return the application secret to a browser.
"""
import ast
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

MEMBER = 'google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/oauth_manager.py'
KEYS = ('_DEFAULT_CLIENT_ID', '_DEFAULT_CLIENT_SECRET', '_DEFAULT_SCOPES')


def read_defaults(archive):
    fd = os.open(archive, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0))
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_uid not in (0, os.getuid()) or info.st_size > 2 * 1024**3:
            raise ValueError('Untrusted native package')
        with os.fdopen(fd, 'rb', closefd=False) as handle, zipfile.ZipFile(handle) as package:
            member = package.getinfo(MEMBER)
            if member.file_size > 65536:
                raise ValueError('Native configuration exceeds limit')
            source = package.read(member).decode('utf-8')
        values = {}
        for node in ast.parse(source).body:
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in KEYS:
                        values[target.id] = ast.literal_eval(node.value)
        client_id, client_secret, scopes = (values[key] for key in KEYS)
        if not isinstance(client_id, str) or not client_id.endswith('.apps.googleusercontent.com') or len(client_id) > 256:
            raise ValueError('Invalid native application identity')
        if not isinstance(client_secret, str) or not 1 <= len(client_secret) <= 256:
            raise ValueError('Invalid native application configuration')
        if not isinstance(scopes, list) or not 1 <= len(scopes) <= 16 or any(not isinstance(scope, str) or len(scope) > 256 or not (scope.startswith('https://www.googleapis.com/auth/') or scope in ('openid', 'email', 'profile')) for scope in scopes):
            raise ValueError('Invalid native application scopes')
        return dict(clientId=client_id, clientSecret=client_secret, scopes=scopes)
    finally:
        os.close(fd)


def main():
    try:
        if len(sys.argv) != 2:
            raise ValueError('Expected native package path')
        print(json.dumps(read_defaults(Path(sys.argv[1]))))
        return 0
    except Exception:
        # No vendor source, paths, profile contents or configuration in diagnostics.
        print('Native application configuration unavailable', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

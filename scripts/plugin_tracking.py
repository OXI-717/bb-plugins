#!/usr/bin/env python3
"""One-time BB 0.49 Git tracking migration; no plugin removal or activation."""
import argparse
import json
import os
import re
import sqlite3
import subprocess
from pathlib import Path

FIELDS = ('source', 'source_git_requested_ref', 'source_git_ref_kind',
          'source_git_range', 'source_git_tag_prefix', 'source_git_resolved_tag')

def remote(url, *args):
    return subprocess.run(['git', 'ls-remote', *[a for a in args if a.startswith('--')], url, *[a for a in args if not a.startswith('--')]], check=True,
                          capture_output=True, text=True, timeout=45).stdout

def plan(row):
    url, version = row['source_git_url'], row['version']
    tag_output = remote(url, '--tags')
    tag_commits = {line.split()[1].removeprefix('refs/tags/'):line.split()[0] for line in tag_output.splitlines()}
    tags = [line.split('refs/tags/', 1)[1] for line in tag_output.splitlines()
            if 'refs/tags/' in line and not line.endswith('^{}')]
    matches = [tag for tag in tags if tag == 'v' + version or tag.endswith('/v' + version)]
    subdir = row['source_git_subdirectory'] or ''
    if len(matches) > 1:
        matches = [tag for tag in matches if tag.rsplit('/v', 1)[0] == subdir.split('/')[-1]]
    if len(matches) == 1 and tag_commits.get(matches[0]+'^{}',tag_commits.get(matches[0])) == row['git_resolved_commit'] and re.fullmatch(r'\d+\.\d+\.\d+', version):
        prefix = matches[0][:-len('v' + version)]
        return dict(zip(FIELDS, [f'git:{url}@semver:{prefix + chr(58) if prefix else str()}^{version}', None, None,
                                '^' + version, prefix, matches[0]]))
    head = remote(url, '--symref', 'HEAD')
    match = re.search(r'^ref: refs/heads/([^\s]+)\s+HEAD$', head, re.M)
    if not match:
        raise RuntimeError('No unambiguous default branch: ' + row['id'])
    branch = match.group(1)
    return dict(zip(FIELDS, [f'git:{url}@{branch}', branch, 'branch', None, None, None]))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--backup', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    db = sqlite3.connect(f'file:{args.database}?mode=rw', uri=True, timeout=15)
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute("SELECT * FROM plugins WHERE removed_at IS NULL AND source_kind='git' AND source_git_range IS NULL AND source_git_ref_kind IN ('commit','tag')")]
    changes = [(row, plan(row)) for row in rows]
    if args.apply:
        # Backup only source registrations, never settings/secrets or whole BB state.
        args.backup.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(args.backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump([{'id': r['id'], 'before': {k:r[k] for k in FIELDS}, 'after': p}
                       for r,p in changes], out, indent=2)
            out.flush(); os.fsync(out.fileno())
        db.execute('BEGIN IMMEDIATE')
        try:
            for row, change in changes:
                current = dict(db.execute('SELECT * FROM plugins WHERE id=?', (row['id'],)).fetchone())
                if current != row:
                    raise RuntimeError('Registration changed concurrently: ' + row['id'])
                db.execute('UPDATE plugins SET '+','.join(k+'=?' for k in FIELDS)+' WHERE id=?',
                           (*[change[k] for k in FIELDS], row['id']))
                after = dict(db.execute('SELECT * FROM plugins WHERE id=?', (row['id'],)).fetchone())
                assert after == {**row, **change}
            db.commit()
        except BaseException:
            db.rollback(); raise
    print(json.dumps({'applied': args.apply, 'changes': [{'id':r['id'], **p} for r,p in changes]}, indent=2))

if __name__ == '__main__':
    main()

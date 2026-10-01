"""Synthetic end-to-end upgrade rehearsal. Never invokes a real BB process."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from unittest.mock import patch


def sandbox(upgrader):
    u = upgrader
    with tempfile.TemporaryDirectory(prefix='pool-upgrade-sandbox-') as temporary:
        root = Path(temporary)
        data = root / 'plugin'
        output = root / 'run'
        data.mkdir(mode=0o700)
        output.mkdir(mode=0o700)
        with contextlib.closing(sqlite3.connect(data / 'data.db')) as db:
            db.execute('CREATE TABLE fixture (value TEXT)')
            db.execute("INSERT INTO fixture VALUES ('synthetic state')")
            db.commit()
        state = {
            'accepting': True, 'inFlight': 0, 'enabledAccountCount': 1,
            'routing': {'codex': True},
            'hosts': [{'hostId':'host-test', 'hostName':'Sandbox machine', 'mintedAt':1, 'lastUsedAt':2}],
            'accounts': [{'id':'account-test', 'provider':'codex', 'kind':'api-key',
                          'enabled':True, 'priority':10, 'role':'primary', 'cap':None,
                          'policy':{'enabled':False}, 'drainOnce':True,
                          'drainGeneration':'synthetic-generation', 'inFlight':0,
                          'lastUsedHostId':'host-test'}],
        }
        updated = False
        status_reads = 0
        events = []

        def command(*args, **kwargs):
            nonlocal updated, status_reads
            events.append(args)
            if args == ('git', 'ls-remote', '--tags', u.REPO, 'refs/tags/' + u.PREFIX + 'v*'):
                return 'a'*40 + ' refs/tags/' + u.PREFIX + 'v1.0.0\n' + 'b'*40 + ' refs/tags/' + u.PREFIX + 'v1.0.1\n'
            if args == ('bb', 'plugin', 'update', u.PLUGIN, '--yes'):
                # This is the only simulated mutation, and it changes only this fixture.
                if not (output/'backup'/'data.db').is_file():
                    raise AssertionError('Update preceded backup')
                if not (output/'backup'/'state.json').is_file():
                    raise AssertionError('Missing inventory backup')
                updated = True
                return 'Synthetic update completed'
            if args == ('bb','pool','status','--json'):
                status_reads += 1
                if status_reads == 1:
                    return json.dumps({**state, 'inFlight':1, 'accounts':[{**state['accounts'][0], 'inFlight':1}]})
            responses = {
                ('bb','plugin','list','--json'): {'plugins':[{'id':u.PLUGIN,'enabled':True,'version':'1.0.1' if updated else '1.0.0'}]},
                ('bb','plugin','source',u.PLUGIN,'--json'): {
                    'requested':'git:'+u.REPO+'@semver:'+u.PREFIX+':^1.0.0',
                    'range':'^1.0.0', 'tagPrefix':u.PREFIX, 'subdirectory':'plugins/'+u.PLUGIN,
                    'history':[{'version':('b' if updated else 'a')*40}],
                },
                ('bb','pool','status','--json'): state,
                ('bb','thread','list','--include-hidden','--json'): [],
                ('bb','plugin','config',u.PLUGIN,'--json'): {'values':{'switchThreshold':.98}},
            }
            if args not in responses:
                raise AssertionError('Sandbox rejected an unexpected command')
            return json.dumps(responses[args])

        def release(request, **kwargs):
            expected = 'https://api.github.com/repos/OXI-717/bb-plugins/releases/tags/' + u.urllib.parse.quote(u.PREFIX+'v1.0.1', safe='')
            if request.full_url != expected:
                raise AssertionError('Sandbox rejected an unexpected HTTP request')
            return io.StringIO(json.dumps({'tag_name':u.PREFIX+'v1.0.1','immutable':True,'draft':False,'prerelease':False}))

        def forbidden(*args, **kwargs):
            raise AssertionError('Sandbox forbids real subprocesses and network connections')

        args = argparse.Namespace(check=False, version=None, interrupt_now=False)
        print('SANDBOX: temporary synthetic database; real BB and network calls are blocked.', flush=True)
        try:
            with contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(u, 'run', side_effect=command))
                stack.enter_context(patch.object(u.subprocess, 'run', side_effect=forbidden))
                stack.enter_context(patch('socket.create_connection', side_effect=forbidden))
                stack.enter_context(patch.object(u.urllib.request, 'urlopen', side_effect=release))
                stack.enter_context(patch.object(u.time, 'sleep'))
                stack.enter_context(patch.object(u, 'confirm_interrupt', side_effect=forbidden))
                result = u.perform(args, data, output, print)
            if result != 'PASS' or not updated:
                raise AssertionError('Workflow did not complete')
            if events.count(('bb','plugin','update',u.PLUGIN,'--yes')) != 1:
                raise AssertionError('Expected exactly one synthetic update')
            if events.count(('bb','pool','status','--json')) < 7:
                raise AssertionError('Idle or verification checks were skipped')
            with contextlib.closing(sqlite3.connect(output/'backup'/'data.db')) as db:
                if db.execute('SELECT value FROM fixture').fetchone()[0] != 'synthetic state':
                    raise AssertionError('Backup contents differ')
        except Exception as error:
            print(f'SANDBOX FAILED: {type(error).__name__}: {error}', flush=True)
            return 1
        print('SANDBOX PASS: actual workflow, reporter, backup and verification completed; no live update.', flush=True)
        return 0

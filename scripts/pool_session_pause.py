"""Durable stop/update/continue orchestration through supported BB commands."""
import json
import os
from pathlib import Path
import time
import uuid


class SessionPause:
    def __init__(self, path, bb, say, *, clock=time.monotonic, sleep=time.sleep):
        self.path = Path(path)
        self.bb = bb
        self.say = say
        self.clock = clock
        self.sleep = sleep
        self.state = {'schemaVersion': 1, 'operationId': str(uuid.uuid4()),
                      'phase': 'snapshot', 'sessions': []}

    def save(self):
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(self.state, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)

    @staticmethod
    def identity(thread):
        return {key: thread.get(key) for key in
                ('id', 'projectId', 'environmentId', 'providerId', 'updatedAt', 'status')}

    def show(self, thread_id):
        return self.identity(self.bb('thread', 'show', thread_id)['thread'])

    def stop(self):
        threads = self.bb('thread', 'list', '--include-hidden')
        if not isinstance(threads, list):
            raise ValueError('Invalid thread inventory')
        for thread in threads:
            if thread.get('status') in ('active', 'starting') and not thread.get('archivedAt'):
                snapshot = self.identity(thread)
                if not all(snapshot.get(key) is not None for key in
                           ('id', 'projectId', 'environmentId', 'providerId', 'updatedAt')):
                    raise ValueError('Incomplete active session metadata; nothing stopped')
                self.state['sessions'].append({'before': snapshot, 'action': 'pending'})
        self.save()
        self.say(f"Stopping {len(self.state['sessions'])} active sessions across all hosts; history retained.")
        self.state['phase'] = 'stopping'
        self.save()
        for entry in self.state['sessions']:
            thread_id = entry['before']['id']
            if self.show(thread_id) != entry['before']:
                entry['action'] = 'changed-before-stop'
                self.save()
                continue
            entry['action'] = 'stop-intent'
            self.save()
            self.bb('thread', 'stop', thread_id)
            entry['action'] = 'stop-returned'
            self.save()
            deadline = self.clock() + 60
            while True:
                stopped = self.show(thread_id)
                if stopped['status'] == 'idle':
                    entry['stopped'] = stopped
                    entry['action'] = 'stopped'
                    self.save()
                    break
                if stopped['status'] not in ('active', 'starting', 'stopping') or self.clock() >= deadline:
                    raise RuntimeError('Session stop did not settle; inspect operation receipt')
                self.sleep(1)
        self.state['phase'] = 'stopped'
        self.save()

    def resume(self):
        self.state['phase'] = 'resuming'
        self.save()
        failures = 0
        for entry in self.state['sessions']:
            if entry['action'] in ('stop-intent', 'stop-returned', 'resume-intent'):
                failures += 1
                continue
            if entry['action'] != 'stopped':
                continue
            try:
                if self.show(entry['before']['id']) != entry['stopped']:
                    entry['action'] = 'changed-after-stop'
                    self.save()
                    continue
                entry['action'] = 'resume-intent'
                self.save()
                self.bb('thread', 'tell', entry['before']['id'],
                        'Please continue the interrupted task. The pool maintenance operation has ended.')
                entry['action'] = 'resumed'
                self.save()
            except Exception:
                # A timed-out send may have succeeded. Never send it twice on recovery.
                failures += 1
        self.state['phase'] = 'needs-inspection' if failures else 'finished'
        self.save()
        self.say(f'Session continuation: {self.state["phase"]}. Receipt: {self.path}')
        if failures:
            raise RuntimeError('Some session command outcomes are uncertain; inspect receipt, do not blindly retry')

    def recover(self):
        self.state = json.loads(self.path.read_text())
        if self.state.get('schemaVersion') != 1 or not isinstance(self.state.get('sessions'), list):
            raise ValueError('Unsupported session operation receipt')
        self.resume()

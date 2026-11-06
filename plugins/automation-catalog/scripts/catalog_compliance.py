"""Registry comparison for the existing catalog publisher; no scheduler mutations."""
import hashlib
import json
import time

REQUIRED = ('name', 'owner', 'project', 'purpose', 'source', 'limits', 'stop', 'rollback')


def identity(host, scheduler, scope, unit):
    return json.dumps([host, scheduler, scope, unit], separators=(',', ':'), ensure_ascii=True)


def evaluate(config, inventories, sources, now):
    """All expected hosts/sources are explicit. Failed coverage is never empty success."""
    findings = {}
    def add(kind, ident, summary):
        key = hashlib.sha256((kind + ':' + ident).encode()).hexdigest()[:32]
        try:
            parsed = json.loads(ident)
            host = parsed[0] if isinstance(parsed, list) else config['host']
        except ValueError:
            host = ident if ident in config['hosts'] else config['host']
        findings[key] = dict(kind=kind, identity=ident, summary=summary, host=host)
    registry = {identity(r['host'], r['scheduler'], r['scope'], r['unit']): r for r in config['registry']}
    for host in config['hosts']:
        inv = inventories.get(host)
        if inv is None or now - inv.get('observedAt', 0) > config['staleAfterMs']:
            add('coverage', host, 'Host inventory missing or stale')
            continue
        for c in inv['coverage']:
            if not c['ok']:
                add('coverage', identity(host, c['scheduler'], c['scope'], '*'), 'Scheduler inventory unavailable')
        for row in inv['observations']:
            ident = identity(host, row['scheduler'], row['scope'], row['unit'])
            if ident in registry:
                missing = [field for field in REQUIRED if not registry[ident].get(field)]
                if missing:
                    add('noncompliant', ident, 'Registry fields missing: ' + ', '.join(missing))
                continue
            # Explicit exact/prefix exclusions, constrained to host/scheduler/scope.
            excluded = any(e['host'] == host and e['scheduler'] == row['scheduler'] and e['scope'] == row['scope']
                           and e.get('reason') and (row['unit'] in e.get('units', []) or any(row['unit'].startswith(p) for p in e.get('prefixes', [])))
                           for e in config.get('exclusions', []))
            if not excluded:
                add('unregistered', ident, 'Observed scheduler entry has no registry record')
    for expected in config.get('sources', []):
        source = sources.get(expected)
        if not source or source.get('error') or source.get('lastSuccessAt') is None or now - source['lastSuccessAt'] > source['staleAfterMs']:
            add('coverage', expected, 'Catalog source unavailable or stale')
    return findings


def snapshot(config, findings, previous, now):
    """Stable visible cards; bounded repeat history, recovery recorded only after valid coverage."""
    from catalog_collect import task_base
    tasks, runs = [], []
    state = dict(previous)
    budget = config.get('maxEventsPerCycle', 20)
    keys = sorted(set(findings) | set(previous))
    for key in keys:
        item = findings.get(key)
        old = previous.get(key)
        if item is None and old:
            # A missing host/source is not evidence that its old problems recovered.
            if any(f['kind'] == 'coverage' for f in findings.values()):
                item = dict(old['finding'], unresolved=True)
            elif budget > 0 and old.get('active'):
                runs.append(dict(taskId=key, host=old['finding'].get('host', config['host']), id=f'{key}:{now}:recovered', status='succeeded',
                                 startedAt=now, finishedAt=now, exitCode=0, summary='Inventory finding no longer observed', evidence='execution'))
                state[key] = dict(old, active=False, lastEvent=now)
                budget -= 1
        if item is None:
            if old and old.get('active') and budget == 0:
                item = old['finding']  # Do not silently drop recovery when rate limited.
            else:
                resolved = task_base(key, 'OXI · resolved · ' + old['finding'].get('host', config['host']), old['finding'].get('host', config['host']))
                resolved.update(scheduler='inventory-audit', state='paused', history='available', owner=config['owner'],
                                description='Previous inventory finding recovered. ' + old['finding']['identity'])
                tasks.append(resolved)
                continue
        task = task_base(key, 'OXI · ' + item['kind'] + ' · ' + item.get('host', config['host']), item.get('host', config['host']))
        task.update(scheduler='inventory-audit', state='blocked', history='available', owner=config['owner'],
                    description=item['summary'] + '. Identity: ' + item['identity'] + '. No automatic stop. Inspect original scheduler before disabling.')
        tasks.append(task)
        due = not old or not old.get('active') or now - old['lastEvent'] >= config.get('reminderMs', 86400000)
        if due and budget > 0:
            runs.append(dict(taskId=key, host=item.get('host', config['host']), id=f'{key}:{now}:finding', status='failed',
                             startedAt=now, finishedAt=now, exitCode=1, summary=item['summary'], evidence='execution'))
            state[key] = dict(active=True, lastEvent=now, finding=item)
            budget -= 1
    return dict(source=dict(id=config['sourceId'], name=config['name'], staleAfterMs=config['staleAfterMs']),
                observedAt=now, error=None, tasks=tasks, runs=runs), state

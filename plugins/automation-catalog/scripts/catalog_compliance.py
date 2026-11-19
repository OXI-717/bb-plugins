"""Registry comparison for the existing catalog publisher; no scheduler mutations."""
import hashlib
import json
from catalog_inventory import systemd_execution

REQUIRED = ('name', 'owner', 'project', 'purpose', 'source', 'limits', 'stop', 'rollback')


def identity(host, scheduler, scope, unit):
    return json.dumps([host, scheduler, scope, unit], separators=(',', ':'), ensure_ascii=True)


def fresh_source(source, now):
    return (source is not None and not source.get('error') and source.get('lastSuccessAt') is not None
            and 0 <= now - source['lastSuccessAt'] <= source['staleAfterMs'])


def evaluate(config, inventories, sources, now, *, catalog_tasks=None):
    """All expected hosts/sources are explicit. Failed coverage is never empty success."""
    findings = {}
    def add(kind, ident, summary, *, key_kind=None, **evidence):
        key = hashlib.sha256(((key_kind or kind) + ':' + ident).encode()).hexdigest()[:32]
        try:
            parsed = json.loads(ident)
            host = parsed[0] if isinstance(parsed, list) else config['host']
        except ValueError:
            host = ident if ident in config['hosts'] else config['host']
        findings[key] = dict(kind=kind, identity=ident, summary=summary, host=host, **evidence)
    registry = {identity(r['host'], r['scheduler'], r['scope'], r['unit']): r for r in config['registry']}
    required = [row for row in registry.values() if row.get('expectedPresent') is True]
    required_bb = [row for row in required if row['scheduler'] == 'bb']
    if required_bb:
        source_id = config['bbInventorySource']
        if catalog_tasks is None or not fresh_source(sources.get(source_id), now):
            add('coverage', source_id, 'Catalog source unavailable or stale')
        else:
            # Native IDs belong to the BB instance/project. Target-host metadata
            # can disappear or change while the schedule itself remains present.
            present = {(task.get('projectId'), task['id']) for task in catalog_tasks
                       if task.get('sourceId') == source_id and task.get('scheduler') == 'bb'
                       and task.get('missing') is False}
            for row in required_bb:
                if (row['scope'], row['unit']) not in present:
                    add('missing-required', identity(row['host'], 'bb', row['scope'], row['unit']),
                        'Required automation absent from fresh BB inventory', inventorySource=source_id)
    for host in config['hosts']:
        inv = inventories.get(host)
        if inv is None or not 0 <= now - inv.get('observedAt', 0) <= config['staleAfterMs']:
            add('coverage', host, 'Host inventory missing or stale')
            continue
        coverage = inv.get('coverage')
        if not isinstance(coverage, list) or not coverage or not isinstance(inv.get('observations'), list):
            add('coverage', host, 'Host inventory structure or coverage incomplete')
            continue
        if any(not isinstance(c, dict) or not isinstance(c.get('scheduler'), str) or not isinstance(c.get('scope'), str) or not isinstance(c.get('ok'), bool) for c in coverage):
            add('coverage', host, 'Host coverage malformed')
            continue
        required_here = [row for row in required if row['host'] == host and row['scheduler'] != 'bb']
        scopes = {(item['scheduler'], item['scope']) for item in coverage}
        failed_scopes = {(item['scheduler'], item['scope']) for item in coverage if not item['ok']}
        expected_scopes = {(item['scheduler'], item['scope']) for item in [
            *config.get('coverageRequirements', {}).get(host, []), *required_here]}
        for scheduler, scope in sorted(expected_scopes - scopes):
            add('coverage', identity(host, scheduler, scope, '*'), 'Expected scheduler scope not observed')
        for scheduler, scope in sorted(failed_scopes):
            add('coverage', identity(host, scheduler, scope, '*'), 'Scheduler inventory unavailable')
        observed = {(row['scheduler'], row['scope'], row['unit']) for row in inv['observations']}
        complete_scopes = scopes - failed_scopes
        for row in required_here:
            pair = row['scheduler'], row['scope']
            unit = row['unit']
            if pair in complete_scopes and (*pair, unit) not in observed:
                add('missing-required', identity(host, *pair, unit),
                    'Required job absent from fresh scheduler inventory')
        for row in inv['observations']:
            ident = identity(host, row['scheduler'], row['scope'], row['unit'])
            if ident in registry:
                missing = [field for field in REQUIRED if not registry[ident].get(field)]
                if missing:
                    add('noncompliant', ident, 'Registry fields missing: ' + ', '.join(missing))
                continue
            execution = systemd_execution(row)
            if execution is not None:
                # Preserve the existing identity/card and all earlier audit runs.
                # This is a classification, never an exclusion or a recovery.
                add('execution', ident, 'Observed one-off systemd execution; session outcome is not inferred',
                    key_kind='unregistered', execution=execution, unit=row['unit'], scope=row['scope'])
                continue
            # Explicit exact/prefix exclusions, constrained to host/scheduler/scope.
            excluded = any(e['host'] == host and e['scheduler'] == row['scheduler'] and e['scope'] == row['scope']
                           and e.get('reason') and (row['unit'] in e.get('units', []) or any(row['unit'].startswith(p) for p in e.get('prefixes', [])))
                           for e in config.get('exclusions', []))
            if not excluded:
                data = row.get('systemd', {})
                disproved = (isinstance(data, dict) and data.get('Id') == row['unit']
                             and data.get('LoadState') == 'loaded' and (
                                 data.get('Transient') == 'no' or data.get('Restart') in (
                                     'always', 'on-success', 'on-failure', 'on-abnormal', 'on-watchdog', 'on-abort')
                                 or isinstance(data.get('TriggeredBy'), str) and bool(data['TriggeredBy'])))
                add('unregistered', ident, 'Observed scheduler entry has no registry record',
                    classificationUnknown=not disproved)
    for expected in config.get('sources', []):
        source = sources.get(expected)
        if not fresh_source(source, now):
            add('coverage', expected, 'Catalog source unavailable or stale')
    return findings


def explicitly_classified(config, finding):
    """A registry decision resolves unknown identity, never host/runtime health."""
    if finding.get('kind') != 'unregistered':
        return False
    try:
        host, scheduler, scope, unit = json.loads(finding['identity'])
    except (ValueError, TypeError):
        return False
    for row in config.get('registry', []):
        if (row['host'], row['scheduler'], row['scope'], row['unit']) == (host, scheduler, scope, unit):
            return all(row.get(field) for field in REQUIRED)
    return any(e['host'] == host and e['scheduler'] == scheduler and e['scope'] == scope
               and e.get('reason') and (unit in e.get('units', []) or any(unit.startswith(p) for p in e.get('prefixes', [])))
               for e in config.get('exclusions', []))


def coverage_blocks(old, failed):
    if failed['kind'] != 'coverage':
        return False
    if old.get('inventorySource') is not None:
        return failed['identity'] == old['inventorySource']
    try:
        origin = json.loads(old['identity'])
    except ValueError:
        origin = None
    try:
        missing = json.loads(failed['identity'])
    except ValueError:
        missing = None
    if isinstance(origin, list) and isinstance(missing, list):
        return origin[:3] == missing[:3] or missing[1] == 'host' and origin[0] == missing[0]
    if isinstance(origin, list):
        return failed['identity'] == failed.get('host') and origin[0] == failed.get('host')
    return old['identity'] == failed['identity']


def execution_event(value):
    return {k: value[k] for k in ('invocation', 'status', 'exitCode', 'finishedAt')}


def remember_execution(saved, execution, observed_at=None):
    """Bounded outbox independent of the current unit identity/classification."""
    queue = saved.setdefault('executionEvidence', {})
    invocation = execution['invocation']
    prior = queue.get(invocation)
    terminal = lambda value: value['finishedAt'] is not None and value['status'] in ('failed', 'succeeded')
    if prior and terminal(prior['execution']):
        return prior['execution']  # Partial/late observations cannot undo terminal proof.
    if not prior and len(queue) >= 16:
        # Only acknowledged evidence may leave the bounded outbox. Its durable
        # history remains in the catalog. Never silently evict pending failures.
        evict = next((k for k,v in queue.items() if v.get('published') == execution_event(v['execution'])), None)
        if evict is None:
            saved['executionOverflow'] = True
            return execution
        del queue[evict]
    queue[invocation] = dict(prior or {}, execution=execution,
                             observedAt=prior.get('observedAt') if prior and prior['execution'] == execution else observed_at)
    return execution


def evidence_task(task, saved):
    if saved.get('executionOverflow'):
        task.update(state='blocked', description=task['description'] +
                    ' Evidence queue overflow: more than 16 unacknowledged invocations; history is incomplete. Operator reconciliation required.')
    return task


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
        saved = dict(old or {})
        saved['executionEvidence'] = {k: dict(v) for k,v in saved.get('executionEvidence', {}).items()}
        if old and old['finding']['kind'] == 'execution':
            value = remember_execution(saved, old['finding']['execution'])
            # Compatibility with the first execution-aware state format.
            if old.get('executionEvent') == execution_event(value):
                saved['executionEvidence'][value['invocation']]['published'] = execution_event(value)
        if item and item['kind'] == 'execution':
            value = remember_execution(saved, item['execution'], now)
            item = dict(item, execution=value, **({'unresolved': True} if value != item['execution'] else {}))
        host = (item or (old or {}).get('finding', {})).get('host', config['host'])
        for value in saved['executionEvidence'].values():
            execution = value['execution']
            event = execution_event(execution)
            if value.get('published') != event and budget > 0:
                runs.append(dict(taskId=key, host=host, id='systemd:' + execution['invocation'],
                                 observedAt=value.get('observedAt'), evidence='execution',
                                 **{k: execution[k] for k in ('startedAt', 'finishedAt', 'status', 'exitCode')},
                                 summary='One-off systemd service execution. Exit status is not a session verdict.'))
                value['published'] = event
                budget -= 1
        if saved['executionEvidence'] or saved.get('executionOverflow'):
            state[key] = saved
        if (item and item['kind'] == 'unregistered' and item.get('classificationUnknown')
                and old and old['finding']['kind'] == 'execution'):
            item = dict(old['finding'], unresolved=True)
        if item is None and old:
            if saved.get('executionOverflow'):
                item = dict(old['finding'], unresolved=True)
            elif old['finding']['kind'] == 'execution':
                # Collection by systemd is not evidence of recovery or success.
                item = dict(old['finding'], unresolved=True)
            # A missing host/source is not evidence that its old problems recovered.
            elif old.get('active') and not explicitly_classified(config, old['finding']) and any(coverage_blocks(old['finding'], f) for f in findings.values()):
                item = dict(old['finding'], unresolved=True)
            elif budget > 0 and old.get('active'):
                runs.append(dict(taskId=key, host=old['finding'].get('host', config['host']), id=f'{key}:{now}:recovered', status='succeeded',
                                 startedAt=now, finishedAt=now, exitCode=0, summary=('Identity classified by explicit registry decision; runtime coverage remains separate' if explicitly_classified(config, old['finding']) else 'Inventory finding no longer observed'), evidence='execution'))
                state[key] = dict(state.get(key, old), active=False, lastEvent=now)
                budget -= 1
        if item is None:
            if old and old.get('active') and budget == 0:
                item = old['finding']  # Do not silently drop recovery when rate limited.
            else:
                resolved = task_base(key, 'OXI · resolved · ' + old['finding'].get('host', config['host']), old['finding'].get('host', config['host']))
                resolved.update(scheduler='inventory-audit', state='paused', history='available', owner=config['owner'],
                                description='Previous inventory finding recovered. ' + old['finding']['identity'])
                tasks.append(evidence_task(resolved, saved))
                continue
        if item['kind'] == 'execution':
            execution = item['execution']
            task = task_base(key, 'Одноразовое исполнение · ' + item['unit'], item['host'])
            status = execution['status']
            task.update(scheduler='systemd', executor=item['unit'], scheduleKind='once',
                        schedule='Одноразовый процесс · без собственного расписания',
                        executionId='systemd:' + execution['invocation'],
                        state=('unknown' if item.get('unresolved') and status == 'running' else
                               {'running': 'active', 'succeeded': 'paused', 'failed': 'failed'}.get(status, 'unknown')),
                        history='available', owner=config['owner'],
                        description=(item['scope'] + ' systemd; Transient=yes; Restart=no; TriggeredBy=empty. '
                                     'InvocationID=' + execution['invocation'] + '. '
                                     'Only the service result is known; provider/session attribution is unverified. '
                                     + ('Retained evidence; current observation unconfirmed in live inventory.' if item.get('unresolved') else '')))
            tasks.append(evidence_task(task, saved))
            state[key] = dict(state.get(key, saved), active=True,
                              lastEvent=(old or {}).get('lastEvent', now), finding=item)
            continue
        task = task_base(key, 'OXI · ' + item['kind'] + ' · ' + item.get('host', config['host']), item.get('host', config['host']))
        task.update(scheduler='inventory-audit', state='blocked', history='available', owner=config['owner'],
                    description=item['summary'] + '. Identity: ' + item['identity'] + '. No automatic stop. Inspect original scheduler before disabling.')
        tasks.append(evidence_task(task, saved))
        due = not old or not old.get('active') or old['finding']['kind'] != item['kind'] or now - old['lastEvent'] >= config.get('reminderMs', 86400000)
        if due and budget > 0:
            runs.append(dict(taskId=key, host=item.get('host', config['host']), id=f'{key}:{now}:finding', status='failed',
                             startedAt=now, finishedAt=now, exitCode=1, summary=item['summary'], evidence='execution'))
            state[key] = dict(state.get(key, {}), active=True, lastEvent=now, finding=item)
            budget -= 1
    return dict(source=dict(id=config['sourceId'], name=config['name'], staleAfterMs=config['staleAfterMs']),
                observedAt=now, error=None, tasks=tasks, runs=runs), state

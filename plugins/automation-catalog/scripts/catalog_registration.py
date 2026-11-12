"""Apply explicit registry display metadata without rewriting scheduler identity."""
import json
from pathlib import Path


def overlay(tasks, filename):
    config=json.loads(Path(filename).read_text())
    aliases=config.get('hostAliases', {})
    registry={(r['host'],r['scheduler'],r['scope'],r['unit']):r for r in config['registry']}
    for task in tasks:
        unit=task['id']
        scheduler=task['scheduler']
        if scheduler=='launchd':
            prefix,unit=unit.split(':',1)
            scope='user' if prefix.startswith('gui/') else 'system'
        elif scheduler=='systemd':
            scope,unit=unit.split(':',1)
        elif scheduler=='bb':
            scope=task.get('projectId') or 'unknown'
        else:
            scope='user'
        key=(aliases.get(task['host'],task['host']),scheduler,scope,unit)
        entry=registry.get(key)
        if entry is None:
            continue
        name=entry.get('name')
        if name:
            task['name']=('OXI · '+name+' · '+entry.get('hostLabel',task.get('hostLabel',task['host'])))[:300]
        if entry.get('owner'):
            task['owner']=entry['owner']
        metadata='; '.join(field+': '+str(entry[field]) for field in ('purpose','source','limits','stop','rollback') if entry.get(field))
        task['description']=(metadata+'\n'+task['description'])[:2000]
    return tasks

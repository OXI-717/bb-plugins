"""Validate selected required checks without weakening publication scans."""
import json
import os


def validate(needs):
    for name in ('plan', 'public-hygiene', 'secrets'):
        if needs.get(name, {}).get('result') != 'success':
            raise ValueError(f'Required check did not succeed: {name}')
    selected = needs['plan']['outputs']
    for name, output in [('check', 'check'), ('upgrade-script', 'upgrade'),
                         ('auto-archive', 'archive'), ('oxi-op', 'op')]:
        value = selected[output]
        if value not in ('true', 'false'):
            raise ValueError(f'Invalid selection: {output}')
        allowed = ('success',) if value == 'true' else ('success', 'skipped')
        if needs.get(name, {}).get('result') not in allowed:
            raise ValueError(f'Selected check did not succeed: {name}')


if __name__ == '__main__':
    validate(json.loads(os.environ['RESULTS']))

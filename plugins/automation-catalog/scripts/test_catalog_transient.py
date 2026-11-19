"""One-off classification needs positive systemd evidence, never a name prefix."""
import copy
import tempfile
import unittest

from catalog_inventory import discover, systemd_execution
from catalog_compliance import evaluate, snapshot


def metadata(**changes):
    return dict(Id='sample.service', LoadState='loaded', Transient='yes', Restart='no',
                TriggeredBy='', InvocationID='a' * 32, ActiveState='failed', Result='exit-code',
                ExecMainCode='1', ExecMainStatus='70',
                ExecMainStartTimestamp='Thu 2026-11-19 01:00:00 UTC',
                ExecMainExitTimestamp='Thu 2026-11-19 01:00:02 UTC', **changes)


def row(data=None):
    return dict(scheduler='systemd', scope='system', unit='sample.service', systemd=data or metadata())


class TransientTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(host='worker', hosts=['worker'], registry=[], exclusions=[], sources=[],
                           staleAfterMs=60000, sourceId='coverage', name='Inventory', owner='operator')
        self.inventory = dict(observedAt=1000, coverage=[dict(scheduler='systemd', scope='system', ok=True)],
                              observations=[row()])

    def evaluate(self):
        return evaluate(self.config, {'worker': self.inventory}, {}, 1000)

    def test_metadata_allowlist_and_command_bound(self):
        calls = []
        def run(argv):
            calls.append(argv)
            if 'show' in argv:
                return '\n'.join(k+'='+v for k,v in {**metadata(), 'Environment':'PRIVATE', 'ExecStart':'PRIVATE'}.items())
            if 'list-unit-files' in argv:
                return 'sample@.service disabled disabled\n'
            if argv[0] == 'systemctl':
                return 'sample.service loaded failed failed\n'
            return ''
        with tempfile.TemporaryDirectory() as root:
            result = discover(run, system='Linux', etc=root)
        observed = [r for r in result['observations'] if r['scheduler']=='systemd' and r['unit']=='sample.service']
        self.assertEqual(len(observed), 2)
        self.assertTrue(all(systemd_execution(r)['exitCode']==70 for r in observed))
        self.assertNotIn('PRIVATE', str(result))
        self.assertTrue(all(len(c)<75 for c in calls))
        self.assertTrue(all('sample@.service' not in c for c in calls if 'show' in c))

    def test_legacy_missing_or_unsafe_properties_still_unregistered(self):
        original = metadata()
        for key,value in [('Transient','no'), ('Restart','always'), ('TriggeredBy','sample.timer'),
                          ('InvocationID',''), ('Id','foreign.service'), ('LoadState','not-found'),
                          ('ExecMainStartTimestamp','')]:
            for data in ({**original,key:value}, {k:v for k,v in original.items() if k!=key}):
                with self.subTest(key=key,data=data):
                    self.inventory['observations']=[row(data)]
                    self.assertEqual(next(iter(self.evaluate().values()))['kind'],'unregistered')
        self.inventory['observations']=[dict(scheduler='systemd',scope='system',unit='one-off-looking.service')]
        self.assertEqual(next(iter(self.evaluate().values()))['kind'],'unregistered')

    def test_metadata_budget_expiry_keeps_unclassified_identities(self):
        from unittest.mock import patch
        from catalog_inventory import systemd_metadata
        calls=[]
        with patch('catalog_inventory.time.monotonic', return_value=10):
            data=systemd_metadata(lambda argv:calls.append(argv), ['systemctl'], ['sample.service'], deadline=9)
        self.assertEqual(data,{})
        self.assertEqual(calls,[])

    def test_failed_metadata_read_preserves_identity_and_coverage(self):
        def run(argv):
            if 'show' in argv:raise RuntimeError('denied')
            return 'sample.service loaded failed failed\n' if argv[0]=='systemctl' else ''
        with tempfile.TemporaryDirectory() as root:
            result=discover(run,system='Linux',etc=root)
        self.assertTrue(all('systemd' not in r for r in result['observations']))
        self.assertEqual(len([r for r in result['observations'] if r['scheduler']=='systemd']),2)

    def test_existing_key_no_exclusion_no_fake_success(self):
        legacy=copy.deepcopy(self.inventory)
        legacy['observations'][0].pop('systemd')
        findings=evaluate(self.config,{'worker':legacy},{},1000)
        _,previous=snapshot(self.config,findings,{},1000)
        current=self.evaluate()
        self.assertEqual(set(current),set(findings))
        snap,state=snapshot(self.config,current,previous,1001)
        task=snap['tasks'][0];run=snap['runs'][0]
        self.assertEqual(task['state'],'failed')
        self.assertEqual(task['scheduleKind'],'once')
        self.assertEqual(task['executionId'],run['id'])
        self.assertEqual(run['exitCode'],70)
        self.assertEqual(run['status'],'failed')
        self.assertLess(run['startedAt'],run['finishedAt'])
        self.assertNotEqual(run['startedAt'],1001)
        repeated,_=snapshot(self.config,current,state,1002)
        self.assertEqual(repeated['runs'],[])
        missing,_=snapshot(self.config,{},state,1003)
        self.assertEqual(missing['tasks'][0]['state'],'failed')
        self.assertEqual(missing['runs'],[])
        self.assertIn('Retained evidence',missing['tasks'][0]['description'])

    def test_zero_unknown_signal_and_new_invocation(self):
        for changes,expected in [({'ExecMainStatus':'0','Result':'success','ActiveState':'inactive'},'succeeded'),
                                 ({'ExecMainExitTimestamp':'','ActiveState':'inactive'},'unknown'),
                                 ({'ExecMainStatus':'0','Result':'','ActiveState':'inactive'},'unknown'),
                                 ({'ExecMainExitTimestamp':'','ActiveState':'active'},'running'),
                                 ({'ExecMainCode':'2','ExecMainStatus':'15','Result':'signal'},'failed')]:
            actual=systemd_execution(row({**metadata(),**changes}))
            self.assertEqual(actual['status'],expected)
        snap,state=snapshot(self.config,self.evaluate(),{},1000)
        self.inventory['observations'][0]['systemd']['InvocationID']='b'*32
        second,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertNotEqual(snap['runs'][0]['id'],second['runs'][0]['id'])

    def test_registry_and_required_presence_still_apply(self):
        self.config['registry']=[dict(host='worker',scheduler='systemd',scope='system',unit='sample.service')]
        self.assertEqual(next(iter(self.evaluate().values()))['kind'],'noncompliant')

    def test_running_disappearance_preserves_history_but_current_state_unknown(self):
        self.inventory['observations'][0]['systemd'].update(ExecMainExitTimestamp='', ActiveState='active')
        first,state=snapshot(self.config,self.evaluate(),{},1000)
        later,_=snapshot(self.config,{},state,1001)
        self.assertEqual(first['runs'][0]['status'],'running')
        self.assertEqual(later['tasks'][0]['state'],'unknown')
        self.assertEqual(later['tasks'][0]['executionId'],first['tasks'][0]['executionId'])
        self.assertEqual(later['runs'],[])

    def test_delayed_terminal_survives_disappearance_new_and_previously_running(self):
        for prior_running in (False,True):
            state={}
            if prior_running:
                self.inventory['observations'][0]['systemd'].update(ExecMainExitTimestamp='',ActiveState='active')
                _,state=snapshot(self.config,self.evaluate(),{},999)
            self.inventory['observations'][0]['systemd']=metadata()
            self.config['maxEventsPerCycle']=0
            first,state=snapshot(self.config,self.evaluate(),state,1000)
            self.assertEqual(first['runs'],[])
            self.assertEqual(len(state),1)
            self.config['maxEventsPerCycle']=1
            later,state=snapshot(self.config,{},state,1001)
            self.assertEqual(len(later['tasks']),1)
            self.assertEqual(later['runs'][0]['status'],'failed')
            self.assertEqual(later['runs'][0]['exitCode'],70)
            repeated,_=snapshot(self.config,{},state,1002)
            self.assertEqual(repeated['runs'],[])

    def test_metadata_loss_retains_classification_and_terminal_binding(self):
        first,state=snapshot(self.config,self.evaluate(),{},1000)
        self.inventory['observations'][0].pop('systemd')
        later,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertEqual(later['tasks'][0]['scheduler'],'systemd')
        self.assertEqual(later['tasks'][0]['executionId'],first['tasks'][0]['executionId'])
        self.assertEqual(later['tasks'][0]['state'],'failed')
        self.assertEqual(later['runs'],[])
        self.assertIn('unconfirmed',later['tasks'][0]['description'])
        # Fresh positive evidence of a persistent service invalidates the new classification.
        self.inventory['observations'][0]['systemd']={**metadata(),'Transient':'no'}
        persistent,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertEqual(persistent['tasks'][0]['scheduler'],'inventory-audit')
        # Newly required jobs still pass through registry validation.
        self.inventory['observations'][0].pop('systemd')
        self.config['registry']=[dict(host='worker',scheduler='systemd',scope='system',unit='sample.service',expectedPresent=True)]
        required,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertIn('noncompliant',required['tasks'][0]['name'])

    def test_positive_persistent_evidence_restores_registry_checks(self):
        _,state=snapshot(self.config,self.evaluate(),{},1000)
        self.inventory['observations'][0]['systemd']['Transient']='no'
        later,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertEqual(later['tasks'][0]['scheduler'],'inventory-audit')
        self.assertEqual(later['tasks'][0]['state'],'blocked')

    def test_budget_defers_without_losing_event(self):
        self.config['maxEventsPerCycle']=0
        snap,state=snapshot(self.config,self.evaluate(),{},1000)
        self.assertEqual(snap['runs'],[])
        self.config['maxEventsPerCycle']=1
        snap,_=snapshot(self.config,self.evaluate(),state,1001)
        self.assertEqual(len(snap['runs']),1)


if __name__=='__main__':unittest.main()

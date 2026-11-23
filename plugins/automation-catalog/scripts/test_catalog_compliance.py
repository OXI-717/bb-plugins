import unittest
from catalog_compliance import evaluate, snapshot, identity

class ComplianceTests(unittest.TestCase):
    def setUp(self):
        self.cfg = dict(host='sample', hosts=['sample'], registry=[], exclusions=[], sources=['native'],
                        staleAfterMs=60000, sourceId='coverage', name='Inventory', owner='operator', reminderMs=100)
        self.inv = {'sample': dict(observedAt=1000, coverage=[dict(scheduler='systemd',scope='user',ok=True)],
                                  observations=[dict(scheduler='systemd',scope='user',unit='example.service')])}
        self.sources = {'native': dict(lastSuccessAt=1000, staleAfterMs=60000, error=None)}
    def test_unknown_dedup_reminder_and_recovery(self):
        f = evaluate(self.cfg, self.inv, self.sources, 1000)
        self.assertEqual([v['kind'] for v in f.values()], ['unregistered'])
        a, state = snapshot(self.cfg, f, {}, 1000)
        self.assertEqual(len(a['runs']), 1)
        b, state = snapshot(self.cfg, f, state, 1001)
        self.assertEqual(b['runs'], [])
        c, state = snapshot(self.cfg, f, state, 1100)
        self.assertEqual(len(c['runs']), 1)
        d, state = snapshot(self.cfg, {}, state, 1101)
        self.assertEqual(d['runs'][0]['status'], 'succeeded')
        self.assertEqual(d['tasks'][0]['state'], 'paused')
    def test_access_loss_does_not_recover_unknown(self):
        f = evaluate(self.cfg, self.inv, self.sources, 1000)
        _, state = snapshot(self.cfg, f, {}, 1000)
        lost = evaluate(self.cfg, {}, self.sources, 1001)
        snap, _ = snapshot(self.cfg, lost, state, 1001)
        self.assertFalse(any(r['status']=='succeeded' for r in snap['runs']))
        self.assertEqual(len(snap['tasks']),2)
    def test_exclusions_are_scoped_and_reasoned(self):
        self.cfg['exclusions']=[dict(host='other',scheduler='systemd',scope='user',units=['example.service'],reason='vendor')]
        self.assertEqual(len(evaluate(self.cfg,self.inv,self.sources,1000)),1)
        self.cfg['exclusions'][0]['host']='sample'
        self.assertEqual(evaluate(self.cfg,self.inv,self.sources,1000),{})
    def test_registry_missing_metadata_and_failed_source(self):
        self.cfg['registry']=[dict(host='sample',scheduler='systemd',scope='user',unit='example.service')]
        self.sources['native']['error']='unavailable'
        self.assertEqual({f['kind'] for f in evaluate(self.cfg,self.inv,self.sources,1000).values()}, {'coverage','noncompliant'})


class RegressionTests(ComplianceTests):
    def test_recovered_not_reopened_by_lost_coverage(self):
        f=evaluate(self.cfg,self.inv,self.sources,1000)
        _,state=snapshot(self.cfg,f,{},1000)
        _,state=snapshot(self.cfg,{},state,1001)
        lost=evaluate(self.cfg,{},self.sources,1002)
        result,_=snapshot(self.cfg,lost,state,1002)
        recovered=[t for t in result['tasks'] if t['id'] in state]
        self.assertEqual([t['state'] for t in recovered],['paused'])
    def test_empty_coverage_cannot_recover(self):
        f=evaluate(self.cfg,self.inv,self.sources,1000)
        _,state=snapshot(self.cfg,f,{},1000)
        self.inv['sample'].update(coverage=[],observations=[])
        lost=evaluate(self.cfg,self.inv,self.sources,1001)
        result,_=snapshot(self.cfg,lost,state,1001)
        self.assertFalse(any(r['status']=='succeeded' for r in result['runs']))
    def test_expected_scope_missing_is_unknown(self):
        self.cfg['coverageRequirements']={'sample':[dict(scheduler='cron',scope='root')]}
        f=evaluate(self.cfg,self.inv,self.sources,1000)
        self.assertIn('coverage',[v['kind'] for v in f.values()])
    def test_unrelated_scope_does_not_prevent_recovery(self):
        f=evaluate(self.cfg,self.inv,self.sources,1000)
        _,state=snapshot(self.cfg,f,{},1000)
        self.inv['sample']['observations']=[]
        self.inv['sample']['coverage'].append(dict(scheduler='cron',scope='root',ok=False))
        result,_=snapshot(self.cfg,evaluate(self.cfg,self.inv,self.sources,1001),state,1001)
        self.assertTrue(any(r['status']=='succeeded' for r in result['runs']))

class CoverageEscalationTests(ComplianceTests):
    def test_scheduler_to_host_loss_never_recovers_scheduler(self):
        self.inv['sample']['coverage'][0]['ok']=False
        self.inv['sample']['observations']=[]
        f=evaluate(self.cfg,self.inv,self.sources,1000)
        _,state=snapshot(self.cfg,f,{},1000)
        lost=evaluate(self.cfg,{},self.sources,1001)
        result,_=snapshot(self.cfg,lost,state,1001)
        self.assertFalse(any(r['status']=='succeeded' for r in result['runs']))

class ExplicitRegistrationDuringOutageTests(unittest.TestCase):
    def test_registry_decision_is_not_reopened_by_source_outage(self):
        from catalog_compliance import snapshot, identity
        config={'staleAfterMs':60000,'host':'test-host','hosts':['test-host'],'sourceId':'test','name':'test','owner':'owner','registry':[dict(host='test-host',scheduler='systemd',scope='user',unit='known.service',name='known',owner='owner',project='project',purpose='purpose',source='source',limits='limits',stop='stop',rollback='rollback')],'exclusions':[]}
        ident=identity('test-host','systemd','user','known.service')
        old={'old':{'active':True,'lastEvent':1,'finding':{'kind':'unregistered','identity':ident,'summary':'not registered','host':'test-host'}}}
        failure={'coverage':{'kind':'coverage','identity':'test-host','summary':'offline','host':'test-host'}}
        result,state=snapshot(config,failure,old,100)
        self.assertFalse(state['old']['active'])
        self.assertTrue(any(t['state']=='blocked' for t in result['tasks']))


class RequiredPresenceTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(host='test-host', hosts=['test-host'], sourceId='audit',
                           name='Inventory', owner='Operator', staleAfterMs=60000)
        self.row = dict(host='test-host', scheduler='systemd', scope='user', unit='example.timer',
                        expectedPresent=True)
        self.config['registry'] = [self.row]
        self.host = dict(observedAt=1000, observations=[],
                         coverage=[dict(scheduler='systemd', scope='user', ok=True)])
        self.inventory = {'test-host': self.host}

    def findings(self, sources=None, **kwargs):
        return evaluate(self.config, self.inventory, sources or {}, 1001, **kwargs)

    def kinds(self, sources=None, **kwargs):
        return {f['kind'] for f in self.findings(sources, **kwargs).values()}

    def test_required_presence_is_opt_in_and_independent_of_enablement(self):
        self.assertEqual(self.kinds(), {'missing-required'})
        self.row.pop('expectedPresent')
        self.assertEqual(self.kinds(), set())
        self.row['expectedPresent'] = True
        self.row.update({field: 'registered' for field in
                         ('name', 'owner', 'project', 'purpose', 'source', 'limits', 'stop', 'rollback')})
        self.host['observations'] = [dict(scheduler='systemd', scope='user',
                                          unit='example.timer', enabled=False)]
        self.assertEqual(self.kinds(), set())

    def test_unavailable_or_omitted_scope_does_not_infer_absence(self):
        for coverage in [
            [dict(scheduler='systemd', scope='user', ok=False)],
            [dict(scheduler='systemd', scope='system', ok=True)],
            [dict(scheduler='systemd', scope='user', ok=True),
             dict(scheduler='systemd', scope='user', ok=False)],
        ]:
            with self.subTest(coverage=coverage):
                self.host['coverage'] = coverage
                self.assertEqual(self.kinds(), {'coverage'})
        self.host['observedAt'] = -60000
        self.assertEqual(self.kinds(), {'coverage'})

    def test_coverage_loss_holds_finding_until_confirmed_return(self):
        first, state = snapshot(self.config, self.findings(), {}, 1001)
        self.assertEqual([(t['state'], r['status']) for t, r in zip(first['tasks'], first['runs'])],
                         [('blocked', 'failed')])
        finding_id = first['tasks'][0]['id']
        self.host['coverage'] = [dict(scheduler='systemd', scope='system', ok=True)]
        lost, state = snapshot(self.config, self.findings(), state, 1002)
        self.assertTrue(state[finding_id]['active'])
        self.assertFalse(any(r['taskId'] == finding_id for r in lost['runs']))
        self.host['coverage'] = [dict(scheduler='systemd', scope='user', ok=True)]
        self.host['observations'] = [dict(scheduler='systemd', scope='user', unit='example.timer')]
        returned, state = snapshot(self.config, self.findings(), state, 1003)
        self.assertFalse(state[finding_id]['active'])
        self.assertTrue(any(r['taskId'] == finding_id and r['status'] == 'succeeded'
                            for r in returned['runs']))

    def test_bb_presence_uses_only_fresh_authoritative_source(self):
        self.row.update(scheduler='bb', scope='project-example', unit='auto_example')
        self.config['bbInventorySource'] = 'local-bb'
        source = dict(lastSuccessAt=1000, staleAfterMs=60000, error=None)
        native = {'local-bb': source}
        self.inventory.clear()  # Target machine can be offline while the native schedule still exists.
        present = dict(scheduler='bb', sourceId='local-bb', id='auto_example',
                       projectId='project-example', host='unknown', state='paused', missing=False)
        self.assertEqual(self.kinds(native, catalog_tasks=[present]), {'coverage'})
        for row in [dict(present, missing=True), dict(present, sourceId='other-bb'),
                    dict(present, projectId='other-project')]:
            self.assertEqual(self.kinds(native, catalog_tasks=[row]), {'coverage', 'missing-required'})
        findings = self.findings(native, catalog_tasks=[])
        _, state = snapshot(self.config, findings, {}, 1001)
        finding_id = next(key for key, row in findings.items() if row['kind'] == 'missing-required')
        self.host['observedAt'] = 1001
        self.inventory['test-host'] = self.host
        for unavailable in ({}, {'local-bb':dict(source, error='unreachable')},
                            {'local-bb':dict(source, lastSuccessAt=-60000)}):
            problems = self.findings(unavailable, catalog_tasks=[])
            self.assertEqual({row['kind'] for row in problems.values()}, {'coverage'})
            _, after = snapshot(self.config, problems, state, 1002)
            self.assertTrue(after[finding_id]['active'])
        self.assertEqual(self.kinds(native), {'coverage'})  # No authoritative task payload provided.


if __name__ == '__main__':
    unittest.main()

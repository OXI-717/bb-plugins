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

if __name__=='__main__':unittest.main()

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

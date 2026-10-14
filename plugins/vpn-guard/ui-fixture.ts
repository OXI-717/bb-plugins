import type { z } from 'zod';
import type { statusSchema } from './contract.js';

export function guardFixture(): z.infer<typeof statusSchema> {
  return {
    mode:'enforce',manualBlock:false,serverHostId:'demo-server',hostIds:['demo-server'],
    suspendNativePluginsGlobally:false,
    coordinateAutomations:false,automationControllerPath:null,
    hosts:[{id:'demo-server',name:'Demo machine',selected:true,available:true,vpn:'connected',evidence:{state:'connected',assurance:'verified_ipv4',reason:'ok',updatedAt:Date.now(),probeAt:Date.now()}}],
    protectedProviders:['codex','claude-code','cursor','devin'],
    ownedDisabledPlugins:[],ambiguousPluginChanges:[],stoppedThreadIds:[],limitations:[],
    pool:{linked:true,vpnPolicyVersion:2,error:null},
    automations:{status:null,error:null,held:false,needsReconcile:false},
  };
}

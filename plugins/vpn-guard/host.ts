import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import {selectVpnEvidence} from './passive-state.js';
import { homedir } from 'node:os';
import path from 'node:path';
import {automationCommand} from './automation-host.js';
import { hostContract } from './contract.js';
import { readVpnEvidence } from './trusted-read.js';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    automation:automationCommand,
    async readState(_input, context) {
      const startTotal = performance.now();
      const budget = 2000;
      const signal = context?.signal;
      const file = path.join(homedir(),'.local','state','vpnks','vpn-state.json');

      const fileStart = performance.now();
      const stored = await readVpnEvidence(file);
      const fileDuration = Math.round(performance.now() - fileStart);
      console.debug(`VPN Guard host read stage=file duration=${fileDuration}ms`);

      const remaining = budget - Math.round(performance.now() - startTotal);
      if (remaining <= 0 || signal?.aborted) {
        const err = new Error(signal?.aborted ? 'Host read cancelled' : 'Host read timed out');
        if (signal?.aborted) err.name = 'AbortError';
        throw err;
      }

      const passiveStart = performance.now();
      const evidence = await selectVpnEvidence(file, stored, undefined, { signal, timeoutMs: remaining });
      const passiveDuration = Math.round(performance.now() - passiveStart);
      console.debug(`VPN Guard host read stage=passive duration=${passiveDuration}ms`);

      if (evidence.reason === 'read_deadline' || signal?.aborted || performance.now() - startTotal > budget) {
        const err = new Error(signal?.aborted ? 'Host read cancelled' : 'Host read timed out');
        if (signal?.aborted) err.name = 'AbortError';
        throw err;
      }

      return {state:evidence.state as 'connected'|'disconnected'|'unknown',evidence};
    },
  },
});

import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { homedir } from 'node:os';
import path from 'node:path';
import {automationCommand} from './automation-host.js';
import { hostContract } from './contract.js';
import { readVpnEvidence } from './trusted-read.js';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    automation:automationCommand,
    async readState() {
      const evidence=await readVpnEvidence(path.join(homedir(),'.local','state','vpnks','vpn-state.json'));
      return {state:evidence.state,evidence};
    },
  },
});

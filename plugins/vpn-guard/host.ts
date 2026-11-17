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
    async readState() {
      const file=path.join(homedir(),'.local','state','vpnks','vpn-state.json');
      const evidence=await selectVpnEvidence(file,await readVpnEvidence(file));
      return {state:evidence.state,evidence};
    },
  },
});

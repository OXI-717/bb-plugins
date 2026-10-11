import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { homedir } from 'node:os';
import path from 'node:path';
import { hostContract } from './contract.js';
import { readVpnState } from './trusted-read.js';
export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async readState() {
      return {state: await readVpnState(path.join(homedir(),'.local','state','vpnks','vpn-state.json'))};
    },
  },
});

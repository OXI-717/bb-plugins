import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const source=readFileSync(new URL('../shared/vpn-evidence.ts',import.meta.url),'utf8');
for(const relative of ['../plugins/vpn-guard/vpn-evidence.ts','../plugins/account-pool-balanced/src/vpn-evidence.ts']){
 if(process.argv.includes('--write'))writeFileSync(new URL(relative,import.meta.url),source);
 assert.equal(readFileSync(new URL(relative,import.meta.url),'utf8'),source,`${relative} must match the shared VPN contract`);
}
console.log('VPN contract copies match; each plugin ships its consumer independently.');

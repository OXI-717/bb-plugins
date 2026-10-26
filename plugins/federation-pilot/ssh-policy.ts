// OpenSSH config is user controlled: refuse implicit tunnels before starting ours.
export const SSH_OPTIONS=['-a','-x','-o','ForwardAgent=no','-o','ForwardX11=no','-o','PermitLocalCommand=no','-o','Tunnel=no'];
export function assertSafeSshConfig(output:string){
  for(const line of output.split(/\r?\n/)){
    const [key,...values]=line.trim().split(/\s+/);const value=values.join(' ').toLowerCase();
    if(['remoteforward','dynamicforward','localforward'].includes(key)&&value&&value!=='none')throw Error('SSH profile contains implicit forwarding; use a dedicated profile without forwarding');
    if(key==='tunnel'&&!['no','false'].includes(value))throw Error('SSH tunnel device forwarding is not supported');
    if(key==='forwardagent'&&!['no','false'].includes(value))throw Error('SSH profile enables agent forwarding; disable it for this destination');
  }
}

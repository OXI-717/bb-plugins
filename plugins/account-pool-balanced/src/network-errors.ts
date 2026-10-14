import type {PoolProvider} from './contracts.js';
export class VpnRequiredError extends Error {
  readonly code:string = 'VPN_REQUIRED';
  constructor(readonly provider: PoolProvider) {
    super(`VPN_REQUIRED: ${provider} requires a confirmed VPN connection on the pool server.`);
  }
}


export class GuardRequiredError extends VpnRequiredError {
  override readonly code:string;
  constructor(provider:PoolProvider,unavailable=false,readonly failureReason?:'timeout'|'invalid_decision'|'rpc_failed') {
    super(provider);this.code=unavailable?'VPN_GUARD_UNAVAILABLE':'VPN_GUARD_BLOCKED';
    this.message=`${this.code}: protected pool traffic requires VPN Guard permission.${failureReason?` Guard check: ${failureReason}.`:''}`;
  }
}

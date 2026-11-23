import type {VpnState} from './vpn-evidence.js';
import type {StopReason} from './contract.js';

/**
 * How long a selected machine may stay continuously unobservable before Guard
 * acts on running work (thread stops, native suspension, automation holds).
 * Admission of new turns and Pooler decisions never use this grace period.
 */
export const OBSERVATION_GRACE_MS=90_000;

export type UnobservedReason='host_rpc_failed'|'host_catalog_unavailable';
export type NetworkMode='direct'|'vpn-required';
/** One read of a selected machine: either it answered, or it could not be observed. */
export type Reading=
  |{kind:'evidence';state:VpnState;reason:StopReason|undefined}
  |{kind:'unobservable';reason:UnobservedReason};
/**
 * Effective decision basis for actions on running work.
 * - `connected`: the latest effective evidence is connected.
 * - `blocked`: the latest effective evidence explicitly says not connected.
 * - `expired`: unobservable for longer than the grace period.
 * - `pending`: unobservable within the grace period and no evidence since start.
 */
export type Verdict=
  |{kind:'connected'}
  |{kind:'blocked';state:VpnState;reason:StopReason}
  |{kind:'expired';reason:UnobservedReason}
  |{kind:'pending'};

type Evidence={state:VpnState;reason:StopReason|undefined;receivedAt:number};
type Track={networkMode:NetworkMode;readAt:number;evidence:Evidence|null;unobservedSince:number|null;unobservedReason:UnobservedReason|null};

export function observationTracker(graceMs=OBSERVATION_GRACE_MS) {
  const tracks=new Map<string,Track>();
  const fromEvidence=(evidence:Evidence):Verdict=>evidence.state==='connected'?{kind:'connected'}:{kind:'blocked',state:evidence.state,reason:evidence.reason??'invalid_evidence'};
  return {
    /** `readAt` is when the read started; an older read finishing late never overrides a newer one. */
    record(hostId:string,networkMode:NetworkMode,reading:Reading,readAt:number,receivedAt:number) {
      let track=tracks.get(hostId);
      // Evidence of one network mode says nothing about the other.
      if(!track||track.networkMode!==networkMode)track={networkMode,readAt:Number.NEGATIVE_INFINITY,evidence:null,unobservedSince:null,unobservedReason:null};
      tracks.set(hostId,track);
      if(readAt<track.readAt)return;
      track.readAt=readAt;
      if(reading.kind==='evidence') {
        track.evidence={state:reading.state,reason:reading.state==='connected'?undefined:reading.reason,receivedAt};
        track.unobservedSince=null;track.unobservedReason=null;
      } else {
        track.unobservedSince??=readAt;
        track.unobservedReason=reading.reason;
      }
    },
    verdict(hostId:string,now:number):Verdict {
      const track=tracks.get(hostId);
      if(!track)return {kind:'pending'};
      if(track.unobservedSince===null)return track.evidence?fromEvidence(track.evidence):{kind:'pending'};
      if(now-track.unobservedSince>graceMs)return {kind:'expired',reason:track.unobservedReason??'host_rpc_failed'};
      return track.evidence?fromEvidence(track.evidence):{kind:'pending'};
    },
    view(hostId:string):{lastEvidenceAt:number|null;unobservedSince:number|null} {
      const track=tracks.get(hostId);
      return {lastEvidenceAt:track?.evidence?.receivedAt??null,unobservedSince:track?.unobservedSince??null};
    },
    retain(hostIds:readonly string[]) {
      const keep=new Set(hostIds);
      for(const id of [...tracks.keys()])if(!keep.has(id))tracks.delete(id);
    },
  };
}
export type ObservationTracker=ReturnType<typeof observationTracker>;
/** Blocked or expired: act on running work for this machine. */
export const actsOnRunningWork=(verdict:Verdict|undefined)=>verdict?.kind==='blocked'||verdict?.kind==='expired';

import {createHash} from 'node:crypto';
import { providerBudgetEvidenceSchema, type ProviderBudgetEvidence, type PoolProvider, type AccountQuota } from './contracts.js';
import { parseReset, modelFamily } from './quota.js';

// Existing non-ZAI collectors run every five minutes. This separate contract
// allows two collection intervals; it changes neither existing budget TTL.
export const PROVIDER_BUDGET_MAX_AGE_MS = 600_000;
export const NUMERIC_BUDGET_PROVIDERS = ['claude','kimi','opencode-go','cursor','agy','neuraldeep'] as const;
export const ADDITIONAL_BUDGET_PROVIDERS = [...NUMERIC_BUDGET_PROVIDERS,'devin'] as const;
type Window = ProviderBudgetEvidence['windows'][number];
function object(v:unknown):Record<string,unknown> {return v!==null && typeof v==='object' && !Array.isArray(v)?v as Record<string,unknown>:{};}
function number(v:unknown):number|null {
  if(typeof v!=='number' && !(typeof v==='string' && /^\d+(?:\.\d+)?$/u.test(v)))return null;
  const n=Number(v);return Number.isFinite(n)?n:null;
}
function window(id:string,percent:unknown,reset:unknown,durationMinutes:number|null,now:number):Window|null {
  const used=number(percent);
  if(used===null||used<0||used>100||!['string','number'].includes(typeof reset))return null;
  // parseReset's numeric compatibility must not accept empty/hex numeric strings.
  if(typeof reset==='string' && (!reset.trim() || (/^[0-9+.\-]/u.test(reset) && !/^\d+(?:\.\d+)?$/u.test(reset) && !/^\d{4}-\d{2}-\d{2}T/u.test(reset))))return null;
  const resetAt=parseReset(reset as string|number);
  if(resetAt===null||!Number.isSafeInteger(resetAt)||resetAt<=now)return null;
  return {id,remainingPercent:100-used,resetAt,durationMinutes};
}
/** New, complete provider payloads only. No legacy-cache or header promotion. */
export function providerEvidenceFromUsage(provider:PoolProvider,payload:unknown,now:number):ProviderBudgetEvidence|undefined {
  const p=object(payload),windows:Array<Window|null>=[];
  if(p.error!=null||p.success===false)return undefined;
  const statusAllowed=(status:unknown)=>status==null||status==='allowed'||status==='ok';
  if(provider==='claude') {
    const bucket=(id:string,v:unknown,duration:number)=>{const b=object(v);
      if(!statusAllowed(b.status))return null;
      const values=[b.used_percentage,b.utilization,b.usedPercentage].filter(x=>x!=null);
      if(values.some(x=>number(x)===null)||new Set(values.map(number)).size>1)return null;
      return window(id,b.used_percentage??b.utilization??b.usedPercentage,b.resets_at??b.reset_at??b.resetAt,duration,now);};
    windows.push(bucket('fiveHour',p.five_hour,300),bucket('weekly',p.seven_day,10080));
    for(const family of ['fable','sonnet','opus','haiku'] as const)if(p[`seven_day_${family}`]!=null)windows.push(bucket(`family:${family}`,p[`seven_day_${family}`],10080));
    if(p.limits!==undefined) {
      if(!Array.isArray(p.limits)||p.limits.length>16)return undefined;
      for(const v of p.limits){const r=object(v),name=object(object(r.scope).model).display_name;
        if((r.kind!=='weekly_scoped' && r.group!=='weekly')||typeof name!=='string'||!statusAllowed(r.status))return undefined;
        windows.push(window(`family:${modelFamily(name)}`,r.percent,r.resets_at,10080,now));
      }
    }
  } else if(provider==='opencode-go') {
    const usage=object(p.usage);
    for(const [id,key,duration] of [['fiveHour','rolling',300],['weekly','weekly',10080],['monthly','monthly',43200]] as const){const b=object(usage[key]);if(b.status!=null&&b.status!=='ok')return undefined;windows.push(window(id,b.percent,b.resetsAt,duration,now));}
  } else if(provider==='kimi') {
    const read=(id:string,v:unknown,duration:number)=>{const d=object(v),limit=number(d.limit),used=number(d.used),remaining=number(d.remaining);
      if((d.used!=null&&used===null)||(d.remaining!=null&&remaining===null)||limit===null||limit<=0||(used===null&&remaining===null)|| (used!==null&&(used<0||used>limit)) || (remaining!==null&&(remaining<0||remaining>limit)) || (used!==null&&remaining!==null&&Math.abs(used+remaining-limit)>0.000001))return null;
      return window(id,(used??(limit-remaining!))/limit*100,d.resetTime??d.resetAt??d.reset_at,duration,now);};
    windows.push(read('weekly',p.usage,10080));
    if(!Array.isArray(p.limits)||p.limits.length===0||p.limits.length>8)return undefined;
    for(const value of p.limits){const r=object(value),w=object(r.window),duration=number(w.duration),unit=typeof w.timeUnit==='string'?w.timeUnit.toUpperCase().replace(/^TIME_UNIT_/u,''):'';
      const factor=({MINUTE:1,MINUTES:1,HOUR:60,HOURS:60,DAY:1440,DAYS:1440,SECOND:1/60,SECONDS:1/60} as Record<string,number>)[unit];
      const minutes=duration!==null&&factor!==undefined?duration*factor:NaN;
      if(!Number.isSafeInteger(minutes)||minutes<=0)return undefined;
      windows.push(read(`rolling:${minutes}`,r.detail,minutes));
    }
  } else if(provider==='neuraldeep') {
    const chat=object(p.chat),decision=object(p.decision);
    if(object(p.key).status!=='ok'||typeof decision.can_request!=='boolean'||number(chat.cooldown_sec)===null||Number(chat.cooldown_sec)<0)return undefined;
    for(const [id,key,duration] of [['session','session',null],['weekly','week',10080]] as const){
      const b=object(chat[key]),limit=number(b.limit),remaining=number(b.remaining);
      if(limit===null||limit<=0||remaining===null||remaining<0||remaining>limit)return undefined;
      // The public limits contract does not promise reset timestamps. Preserve
      // that unknown instead of inventing a reset or a five-hour session.
      windows.push({id,remainingPercent:remaining/limit*100,resetAt:null,durationMinutes:duration});
    }
  } else if(provider==='agy') {
    // Native CCPA retrieveUserQuotaSummary: all reported groups/buckets, without
    // assuming their names mean weekly or mapping them to arbitrary model IDs.
    if(!Array.isArray(p.groups)||p.groups.length===0||p.groups.length>8)return undefined;
    const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
    const label=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f]/u.test(v)?v:null;
    for(const raw of p.groups){const group=object(raw),groupId=label(group.groupId??group.group_id??group.displayName??group.display_name);
      if(!groupId||!Array.isArray(group.buckets)||group.buckets.length===0||group.buckets.length>16)return undefined;
      for(const rawBucket of group.buckets){const bucket=object(rawBucket),bucketId=label(bucket.bucketId??bucket.bucket_id??bucket.displayName??bucket.display_name??bucket.window);
        const fraction=number(bucket.remainingFraction??bucket.remaining_fraction);
        if(!bucketId||bucket.disabled===true||fraction===null||fraction<0||fraction>1)return undefined;
        windows.push(window(`group:${hash(groupId)}:${hash(bucketId)}`,(1-fraction)*100,bucket.resetTime??bucket.reset_time,null,now));
      }
    }
  } else if(provider==='cursor')windows.push(window('billingCycle',object(p.planUsage).totalPercentUsed,p.billingCycleEnd,null,now));
  else return undefined;
  if(windows.some(w=>w===null))return undefined;
  const valid=windows as Window[];
  if(new Set(valid.map(w=>w.id)).size!==valid.length)return undefined;
  const parsed=providerBudgetEvidenceSchema.safeParse({provider,source:'usage',observedAt:now,windows:valid,...(provider==='neuraldeep'?{canRequest:object(p.decision).can_request===true&&Number(object(p.chat).cooldown_sec)===0}:{})});
  return parsed.success?parsed.data:undefined;
}
export function providerBudgetQuota(provider:PoolProvider,quota:AccountQuota,now:number) {
  const supported=NUMERIC_BUDGET_PROVIDERS.some(p=>p===provider);
  const parsed=providerBudgetEvidenceSchema.safeParse(quota.providerBudgetEvidence);
  const proof=parsed.success && parsed.data.provider===provider?parsed.data:undefined;
  const held=quota.heldUntil!==null&&quota.heldUntil>now;
  const ids=proof?.windows.map(w=>w.id)??[];
  const required=provider==='claude'?['fiveHour','weekly']:provider==='opencode-go'?['fiveHour','weekly','monthly']:provider==='kimi'?['weekly']:provider==='agy'?[]:provider==='neuraldeep'?['session','weekly']:['billingCycle'];
  const complete=required.every(id=>ids.includes(id)) && new Set(ids).size===ids.length && (provider!=='kimi'||ids.some(id=>id.startsWith('rolling:')));
  const valid=supported&&complete&&proof!==undefined&&proof.observedAt<=now&&now-proof.observedAt<=PROVIDER_BUDGET_MAX_AGE_MS &&
    proof.windows.every(w=>w.resetAt!==null?w.resetAt>now:provider==='neuraldeep')&&(provider!=='neuraldeep'||proof.canRequest===true)&&quota.error===null&&!held;
  return {supported,budgetReady:valid,reason:!supported?'unsupported-numeric-evidence':valid?'ready':held?'held':'missing-stale-or-invalid-evidence',
    providerAllowed:proof?.canRequest??null,usage:proof?{source:'usage',complete:true,observedAt:proof.observedAt}:null,
    windows:valid?proof.windows:[],coverage:provider==='cursor'?'plan-billing-cycle':provider==='agy'?'all-reported-quota-groups':provider==='neuraldeep'?'chat-session-and-week':'reported-subscription-windows'};
}

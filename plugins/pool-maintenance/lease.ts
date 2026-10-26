import { z } from 'zod';
export const leaseSchema = z.object({owner:z.uuid(),createdAt:z.number().int().nonnegative(),expiresAt:z.number().int().positive()}).strict().refine(x=>x.expiresAt>x.createdAt&&x.expiresAt-x.createdAt<=1_800_000);
export type Lease = z.infer<typeof leaseSchema>;
export class MaintenanceLease {
  private lease: Lease|null=null;
  private writer: Promise<unknown>=Promise.resolve();
  constructor(private persist:(value:Lease|null)=>Promise<void>,private now:()=>number=Date.now){}
  async initialize(raw:unknown){
    if(raw===undefined||raw===null)return;
    const value=leaseSchema.parse(raw);
    if(value.expiresAt<=this.now()||value.createdAt>this.now()){await this.persist(null);return;}
    this.lease=value;
  }
  private serialize<T>(fn:()=>Promise<T>):Promise<T>{const next=this.writer.then(fn);this.writer=next.catch(()=>{});return next;}
  status():Lease|null {return this.lease&&this.lease.expiresAt>this.now()?{...this.lease}:null;}
  acquire(owner:string){return this.serialize(async()=>{
    z.uuid().parse(owner);
    const current=this.status();
    if(current){if(current.owner!==owner)throw Error('Another maintenance operation owns the pause');return current;}
    const now=this.now();
    const value={owner,createdAt:now,expiresAt:now+1_800_000};
    await this.persist(value);this.lease=value;return {...value};
  });}
  release(owner:string){return this.serialize(async()=>{
    z.uuid().parse(owner);
    const current=this.status();
    if(current&&current.owner!==owner)throw Error('Cannot release another operation pause');
    if(this.lease&&this.lease.owner!==owner)return false;
    await this.persist(null);this.lease=null;return true;
  });}
}

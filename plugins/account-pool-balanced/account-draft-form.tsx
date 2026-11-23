import React from 'react';
import {Input} from './ui/components/ui/input';
export function AccountDraftForm({email,label,onEmail,onLabel}:{email:string;label:string;onEmail:(value:string)=>void;onLabel:(value:string)=>void}){
 return <div className="space-y-3">
  <label className="block text-sm">Name<Input aria-label="New account name" value={label} onChange={e=>onLabel(e.target.value)}/></label>
  <label className="block text-sm">Email<Input aria-label="New account email" type="email" value={email} onChange={e=>onEmail(e.target.value)}/></label>
  <p className="text-sm text-muted-foreground">The account stays disabled until authorization. Configure its proxy and projects before signing in.</p>
 </div>;
}

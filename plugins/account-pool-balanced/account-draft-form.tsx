import React from 'react';
import {Input} from './ui/components/ui/input';
export function AccountDraftForm({email,label,onEmail,onLabel}:{email:string;label:string;onEmail:(value:string)=>void;onLabel:(value:string)=>void}){
 return <div className="space-y-3">
  <label className="block text-sm">Имя<Input aria-label="Имя нового аккаунта" value={label} onChange={e=>onLabel(e.target.value)}/></label>
  <label className="block text-sm">Почта<Input aria-label="Почта нового аккаунта" type="email" value={email} onChange={e=>onEmail(e.target.value)}/></label>
  <p className="text-sm text-muted-foreground">Аккаунт будет выключен до авторизации. Настройте прокси и проекты перед входом.</p>
 </div>;
}

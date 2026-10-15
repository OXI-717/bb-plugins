export function readableWorkContext(item:{title:string;body?:string;details?:string;url?:string;path?:string;state?:string;status?:string;comments?:{author?:string;body:string}[]}):string{
 return [item.title,item.url??item.path??'',item.state??item.status??'',item.body??item.details??'',...(item.comments??[]).map(c=>`Комментарий${c.author?` · ${c.author}`:''}:\n${c.body}`)].filter(Boolean).join('\n\n');
}

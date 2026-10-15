import type {BbPluginApi} from '@get-bb/plugin-sdk';
import {chatContract,chatHostContract,formatChatContext} from './chat-watch-contract.js';
export function setupChatWatch(bb:BbPluginApi,requireEnabled:()=>Promise<void>=async()=>{}){
 const settings=bb.settings.define({chatWatchHost:{type:'string',label:'Хост анализа чата',default:''},chatWatchDatabase:{type:'string',label:'База наблюдений анализа чата',default:''},chatWatchProject:{type:'string',label:'BB-проект разбора чата',default:''}});
 const client=bb.hosts.experimental_client({contract:chatHostContract});const abort=new AbortController();bb.onDispose(()=>abort.abort());
 async function snapshot(){await requireEnabled();const s=await settings.get();if(!s.chatWatchHost||!s.chatWatchDatabase||!s.chatWatchProject)throw Error('Источник анализа чата не настроен');return {projectId:s.chatWatchProject,snapshot:await client.call('chatSnapshot',{databasePath:s.chatWatchDatabase},{hostId:s.chatWatchHost,timeoutMs:15000,signal:abort.signal})};}
 bb.rpc.register(chatContract,{chatContext:snapshot});
 return {describe:async(projectId:string)=>{const data=await snapshot();if(data.projectId!==projectId)throw Error('Неверный проект разбора чата');return {title:'Автопилот · разбор сообщений чата',context:formatChatContext(data.snapshot)};}};
}

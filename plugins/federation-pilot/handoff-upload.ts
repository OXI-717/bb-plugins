import {createHash} from 'node:crypto';
import {z} from 'zod';
import {handoffUploadSchema} from './handoff-contract.ts';
import {validateImage} from './image-format.ts';

export function handoffBytes(raw:unknown){
 const input=handoffUploadSchema.parse(raw),bytes=Buffer.from(input.bytesBase64,'base64');
 if(bytes.toString('base64')!==input.bytesBase64||bytes.length!==input.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error('Handoff file integrity mismatch');
 const extensions:Record<string,string[]>={'text/plain':['txt'],'text/markdown':['md'],'application/json':['json'],'application/x-ndjson':['jsonl'],'application/pdf':['pdf'],'image/png':['png'],'image/jpeg':['jpg','jpeg'],'image/gif':['gif'],'image/webp':['webp']};
 if(!extensions[input.mimeType]?.includes(input.name.split('.').at(-1)!.toLowerCase()))throw Error('Handoff file extension does not match content type');
 if(input.mimeType.startsWith('image/'))validateImage(bytes,input.mimeType);
 else if(input.mimeType==='application/pdf'){if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Invalid PDF');}
 else {new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(bytes.includes(0))throw Error('Binary content is not a text attachment');}
 return {input,bytes};
}

// Uses only caller-supplied bytes. Never reads a local path, executes a command,
// forwards credentials, or accepts a caller-selected API path/header/method.
export async function uploadHandoffFile(port:number,raw:z.infer<typeof handoffUploadSchema>,signal:AbortSignal){
 const {input,bytes}=handoffBytes(raw),form=new FormData();
 form.set('file',new Blob([new Uint8Array(bytes)],{type:input.mimeType}),input.name);
 const r=await fetch(`http://127.0.0.1:${port}/api/v1/projects/${input.projectId}/attachments`,{method:'POST',body:form,redirect:'error',signal});
 const reader=r.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader)try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>16384){await reader.cancel();throw Error('Attachment response exceeds limit');}chunks.push(part.value);}}finally{reader.releaseLock();}
 return {status:r.status,contentType:r.headers.get('content-type')??'application/octet-stream',bodyBase64:Buffer.concat(chunks).toString('base64')};
}

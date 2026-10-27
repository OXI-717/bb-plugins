/** Native GenAI gateway <-> Code Assist framing. No credential or logging code. */
export type AgyRoute = {kind:'models'} | {kind:'generate'|'stream';model:string};
const MODEL_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const encoder=new TextEncoder();
const MAX_EVENT_BYTES=1024*1024;
const MAX_JSON_BYTES=16*1024*1024;

export function agyRoute(url: URL): AgyRoute | null {
  const marker='/agy/v1beta/models';
  const at=url.pathname.lastIndexOf(marker);
  if(at<0)return null;
  const prefix=url.pathname.slice(0,at);
  if(prefix!==''&&prefix!=='/http'&&!/^\/api\/v1\/plugins\/[A-Za-z0-9_-]+\/http$/.test(prefix))return null;
  const suffix=url.pathname.slice(at+marker.length);
  if(suffix==='')return {kind:'models'};
  const match=/^\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}):(generateContent|streamGenerateContent)$/.exec(suffix);
  if(!match)return null;
  return {kind:match[2]==='streamGenerateContent'?'stream':'generate',model:match[1]!};
}

export function agyRequest(route:AgyRoute,body:Uint8Array,projectId:string):Uint8Array {
  if(!projectId || projectId.length>512)throw Error('Missing server account project');
  if(route.kind==='models')return encoder.encode(JSON.stringify({project:projectId}));
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));
  if(!isObject(value)||!Array.isArray(value.contents))throw Error('Expected a GenAI contents array');
  if('project' in value||'model' in value||'request' in value)throw Error('Expected native GenAI request, without provider envelope');
  return encoder.encode(JSON.stringify({project:projectId,model:route.model,request:value}));
}

function isObject(value:unknown):value is Record<string,unknown> {
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}
function parseJson(text:string):unknown {
  try{return JSON.parse(text) as unknown;}catch{throw Error('Invalid Code Assist JSON');}
}
function unwrap(value:unknown):Record<string,unknown> {
  if(!isObject(value)||!isObject(value.response))throw Error('Invalid Code Assist response envelope');
  return value.response;
}
function models(value:unknown):Record<string,unknown> {
  if(!isObject(value)||!isObject(value.models))throw Error('Invalid Code Assist model catalog');
  return {models:Object.entries(value.models).flatMap(([id,detail])=>{
    if(!MODEL_ID.test(id)||!isObject(detail)||detail.disabled===true)return [];
    return [{name:`models/${id}`,displayName:id,supportedGenerationMethods:['generateContent','streamGenerateContent'],
      ...(typeof detail.maxTokens==='number'&&Number.isSafeInteger(detail.maxTokens)&&detail.maxTokens>0?{inputTokenLimit:detail.maxTokens}:{}),
      ...(typeof detail.maxOutputTokens==='number'&&Number.isSafeInteger(detail.maxOutputTokens)&&detail.maxOutputTokens>0?{outputTokenLimit:detail.maxOutputTokens}:{})}];
  })};
}

export function agyModelIds(value:unknown):string[]{
  const catalog=models(value) as {models:Array<{name:string}>};
  const ids=catalog.models.map(item=>item.name.slice('models/'.length));
  if(ids.length>256)throw Error('Antigravity model catalog exceeds limit');
  return ids;
}

export function agyResponse(route:AgyRoute,response:Response,signal?:AbortSignal,onModels?:(ids:string[])=>Promise<void>):Response {
  if(!response.ok)throw Error('Only successful upstream responses may be transformed');
  if(!response.body)throw Error('Missing upstream response body');
  const media=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if(route.kind==='stream'&&media!=='text/event-stream')throw Error('Expected upstream event stream');
  if(route.kind!=='stream'&&media!=='application/json'&&!media?.endsWith('+json'))throw Error('Expected upstream JSON');
  const decoder=new TextDecoder('utf-8',{fatal:true});
  let pending='';
  let bytes=0;
  const stream=route.kind==='stream';
  const transform=new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){
      if(!stream){bytes+=chunk.byteLength;if(bytes>MAX_JSON_BYTES)throw Error('Upstream JSON exceeds limit');}
      pending+=decoder.decode(chunk,{stream:true});
      if(stream){
        // Frames may be split at any byte, including UTF-8 and CRLF boundaries.
        let boundary:RegExpExecArray|null;
        while((boundary=/\r?\n\r?\n/.exec(pending))!==null){
          const frame=pending.slice(0,boundary.index);pending=pending.slice(boundary.index+boundary[0].length);
          if(encoder.encode(frame).byteLength>MAX_EVENT_BYTES)throw Error('Upstream event exceeds limit');
          const data=frame.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
          if(data)controller.enqueue(encoder.encode(`data: ${JSON.stringify(unwrap(parseJson(data)))}\n\n`));
        }
        if(encoder.encode(pending).byteLength>MAX_EVENT_BYTES)throw Error('Upstream event exceeds limit');
      }
    },
    async flush(controller){
      pending+=decoder.decode();
      if(stream){if(pending.trim()!=='')throw Error('Truncated upstream event');return;}
      const parsed:unknown=parseJson(pending);
      if(route.kind==='models'&&onModels)await onModels(agyModelIds(parsed));
      controller.enqueue(encoder.encode(JSON.stringify(route.kind==='models'?models(parsed):unwrap(parsed))));
    },
  });
  // Framing changed; never forward cookies, encodings, length or account metadata.
  return new Response(response.body.pipeThrough(transform,{signal}),{status:response.status,headers:{'content-type':stream?'text/event-stream':'application/json'}});
}

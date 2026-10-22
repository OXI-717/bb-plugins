import {z} from 'zod';
import {setTimeout as delay} from 'node:timers/promises';
import {GithubCliError} from './cli-failure';
import type {RepositoryItem} from './api';

type ReadClient = (args:string[], timeout?:number, options?:{retryRead?:boolean}) => Promise<string>;
type RestFallback = (gh:ReadClient, repo:string, state:'open'|'closed'|'all', kind:'issue', deadline:number) => Promise<RepositoryItem[]>;
const pageInfo = z.object({hasNextPage:z.boolean(),endCursor:z.string().nullable()});
const metadata = <T extends z.ZodType>(node:T) => z.object({
  nodes:z.array(node).max(100),pageInfo:z.object({hasNextPage:z.boolean()})
});
const envelope = z.object({
  errors:z.array(z.unknown()).optional(),
  data:z.object({repository:z.object({issues:z.object({
    nodes:z.array(z.object({
      number:z.number().int().positive(),title:z.string(),body:z.string().nullable(),
      state:z.enum(['OPEN','CLOSED']),author:z.object({login:z.string()}).nullable(),
      updatedAt:z.string(),url:z.string(),
      labels:metadata(z.object({name:z.string()})),
      assignees:metadata(z.object({login:z.string()})),
    })).max(100),pageInfo,
  })})})
});

/** Issue-only pagination avoids downloading and throwing away every pull request. */
export async function readIssuePages(
  gh:ReadClient,repo:string,state:'open'|'closed'|'all',
  deadline=Date.now()+120_000,fallback?:RestFallback,
):Promise<RepositoryItem[]> {
  const [owner,name]=repo.split('/');
  const states={open:'OPEN',closed:'CLOSED',all:'OPEN,CLOSED'}[state];
  // Query text is fixed apart from a validated state enum; variables never become code.
  const query=`query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){issues(first:100,after:$after,states:[${states}],orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor}nodes{number title body state author{login}updatedAt url labels(first:100){pageInfo{hasNextPage}nodes{name}}assignees(first:100){pageInfo{hasNextPage}nodes{login}}}}}}`;
  const rows:RepositoryItem[]=[];
  const cursors=new Set<string>();
  let cursor:string|null=null,bytes=0;
  for(let page=1;;page++) {
    const stage=`страница ${page} списка задач`;
    const args=['api','graphql','-f',`query=${query}`,'-f',`owner=${owner}`,'-f',`name=${name}`,...(cursor?['-f',`after=${cursor}`]:[])];
    let raw:string;
    for(let attempt=0;;attempt++) {
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new GithubCliError('timeout',null,stage);
      try {
        raw=await gh(args,Math.min(20_000,remaining),{retryRead:false});
        break;
      } catch(error) {
        if(attempt===0 && error instanceof GithubCliError && ['timeout','network'].includes(error.kind) && deadline-Date.now()>500) {
          await delay(250);continue;
        }
        if(error instanceof GithubCliError)throw new GithubCliError(error.kind,null,stage);
        throw error;
      }
    }
    bytes+=Buffer.byteLength(raw,'utf8');
    if(bytes>64*1024*1024)throw new GithubCliError('response_too_large',null,stage);
    let parsed:unknown;
    try {parsed=JSON.parse(raw);} catch {throw new Error('GitHub: некорректный ответ списка задач.');}
    const checked=envelope.safeParse(parsed);
    if(!checked.success || checked.data.errors?.length)throw new Error('GitHub: неполный или некорректный ответ списка задач.');
    const connection=checked.data.data.repository.issues;
    // Never silently truncate labels or assignees at the nested GraphQL page limit.
    if(connection.nodes.some(row=>row.labels.pageInfo.hasNextPage || row.assignees.pageInfo.hasNextPage)) {
      if(fallback)return fallback(gh,repo,state,'issue',deadline);
      throw new Error('GitHub: неполные метаданные списка задач.');
    }
    rows.push(...connection.nodes.map(row=>({
      number:row.number,title:row.title,body:row.body,state:row.state,
      user:row.author,labels:row.labels.nodes,assignees:row.assignees.nodes,
      updated_at:row.updatedAt,html_url:row.url,
    })));
    if(!connection.pageInfo.hasNextPage)return rows;
    const next=connection.pageInfo.endCursor;
    if(!next || cursors.has(next) || connection.nodes.length===0)throw new Error('GitHub: пагинация списка задач не продвигается.');
    cursors.add(next);cursor=next;
  }
}

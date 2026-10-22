export type CliFailureKind='cancelled'|'timeout'|'response_too_large'|'authentication'|'rate_limit'|'forbidden'|'not_found'|'network'|'unknown';
export class GithubCliError extends Error{
 readonly kind:CliFailureKind;
 constructor(kind:CliFailureKind,error:unknown,stage?:string){
  super(cliFailureMessage(kind,error)+(stage?` Этап: ${stage}.`:''));this.name='GithubCliError';this.kind=kind;
 }
}
export function cliFailureKind(error:unknown,stderr:string):CliFailureKind{
 const value=error as {code?:unknown;killed?:boolean;signal?:unknown};
 if(value?.code==='ABORT_ERR')return 'cancelled';
 if(value?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER')return 'response_too_large';
 if(value?.killed&&value.signal==='SIGTERM')return 'timeout';
 if(/rate limit|secondary rate|abuse detection|HTTP 429/i.test(stderr))return 'rate_limit';
 if(/HTTP 401|bad credentials|requires authentication|not logged into/i.test(stderr))return 'authentication';
 if(/HTTP 403|Resource not accessible by|required scopes to execute this query/i.test(stderr))return 'forbidden';
 if(/HTTP 404|Could not resolve to a Repository/i.test(stderr))return 'not_found';
 if(['ENOTFOUND','EAI_AGAIN','ECONNRESET','ETIMEDOUT','ECONNREFUSED','EHOSTUNREACH'].includes(String(value?.code))||/unexpected EOF|connection reset|dial tcp|no such host|i\/o timeout|TLS handshake timeout|error connecting to|network is unreachable|connection refused|HTTP 50[0234]/i.test(stderr))return 'network';
 return 'unknown';
}
export function cliFailureMessage(kind:CliFailureKind,error:unknown):string{
 const messages:Record<Exclude<CliFailureKind,'unknown'>,string>={
  cancelled:'GitHub CLI: запрос отменён.',
  timeout:'GitHub CLI: истекло время ожидания ответа.',
  response_too_large:'GitHub CLI: ответ превышает допустимый объём.',
  authentication:'GitHub CLI: ошибка авторизации (HTTP 401). Проверьте вход выбранного аккаунта.',
  rate_limit:'GitHub CLI: GitHub ограничил частоту запросов (лимит API). Обновите позже.',
  forbidden:'GitHub CLI: доступ запрещён. Проверьте права выбранного аккаунта и SSO.',
  not_found:'GitHub CLI: репозиторий не найден или недоступен выбранному аккаунту.',
  network:'GitHub CLI: временная ошибка соединения с GitHub.'
 };
 if(kind!=='unknown')return messages[kind];
 const code=(error as {code?:unknown})?.code;
 return `GitHub CLI: запрос не выполнен${typeof code==='number'?` (код ${code})`:''}. Обновите данные; если ошибка повторится, нужна диагностика GitHub CLI.`;
}
export function isRetryableGithubRead(args:readonly string[]):boolean{
 // Only a concrete REST read with an explicit option allowlist. GraphQL,
 // implicit POST fields/input, writes and unknown command forms never retry.
 if(args[0]!=='api')return false;
 let endpoint=false;
 for(let i=1;i<args.length;i++){
  const arg=args[i]!;
  if(['--paginate','--slurp','--silent'].includes(arg))continue;
  if(['--jq','-q','--template','-t'].includes(arg)){if(!args[++i])return false;continue;}
  if(arg==='--method'||arg==='-X'){if(args[++i]!=='GET')return false;continue;}
  if(arg==='--method=GET')continue;
  if(arg.startsWith('-')||endpoint||!/^repos\/[\w.-]+\/[\w.-]+(?:[/?]|$)/.test(arg))return false;
  endpoint=true;
 }
 return endpoint;
}

/** Only the newest status request may update the panel; mutations invalidate reads. */
export function createStatusRequests() {
  let sequence=0;
  return {
    start:()=>++sequence,
    isCurrent:(request:number)=>request===sequence,
    invalidate:()=>{sequence++;},
  };
}

import {it,expect} from "vitest";
import {projectAnalysisContext} from "./project-context";
const now=new Date().toISOString();
const status:any={snapshots:[{source:{id:"mac"},updatedAt:now,error:null,data:{status:{projects:[{name:"projectAlpha",host:"bm",state:"enabled"},{name:"projectBeta",host:"mac"}],alerts:["projectAlpha: failure","projectBeta: hidden"]},runs:[{project:"projectAlpha",at:now,phase:"review",engine:"codex",reason:"red"},{project:"projectBeta",reason:"hidden"}]}}]};
it("deduplicates and isolates project evidence in a bounded context",()=>{
 const data:any={data:{project:"projectAlpha",observedAt:now,signals:[{at:now,rows:["projectAlpha: failure","projectAlpha: failure"]}],errors:[]},loading:false};
 const text=projectAnalysisContext(status,"mac","projectAlpha",data);
 expect(text).not.toContain("projectBeta");expect(text.match(/projectAlpha: failure/g)).toHaveLength(1);expect(text.length).toBeLessThan(12000);
});
it("does not present stale project signals as current",()=>{
 const text=projectAnalysisContext(status,"mac","projectAlpha",{data:{project:"projectAlpha",observedAt:"2020-01-01",signals:[{at:now,rows:["old stop"]}],errors:[]}} as any);
 expect(text).not.toContain("old stop");expect(text).toContain("устарела");
});

it("excludes stale source alerts and old host signals after a fresh detail read",()=>{
 const stale=structuredClone(status);stale.snapshots[0].error="offline";
 const text=projectAnalysisContext(stale,"mac","projectAlpha",{data:{project:"projectAlpha",observedAt:now,signals:[{at:"2020-01-01",rows:["old host error"]}],errors:[]}} as any);
 expect(text).not.toContain("projectAlpha: failure");expect(text).not.toContain("old host error");expect(text).toContain("старые предупреждения исключены");
});

it("keeps 20-minute details that the collector still considers fresh",()=>{
 const at=new Date(Date.now()-20*60*1000).toISOString();
 const text=projectAnalysisContext(status,"mac","projectAlpha",{data:{project:"projectAlpha",observedAt:at,signals:[{at,rows:["within detail window"]}],errors:[]}} as any);
 expect(text).toContain("within detail window");
});

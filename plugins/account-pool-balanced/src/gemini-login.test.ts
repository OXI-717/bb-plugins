import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as credentials from "./gemini-credentials.js";
import type { AccountSummary } from "./contracts.js";
import { GeminiLogin } from "./gemini-login.js";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "pool@example.com",
} as AccountSummary;

function loginScript(exitCode: number, prompt: boolean): string {
  return `
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(process.env.ANTIGRAVITY_GEMINI_DIR, "antigravity-cli");
    fs.mkdirSync(dir, { recursive: true });
    if (${prompt}) process.stdout.write("Open https://accounts.google.com/device\\nCode: GEM-1234\\n");
    setTimeout(() => {
      fs.writeFileSync(path.join(dir, "antigravity-oauth-token"), JSON.stringify({
        token: {
          access_token: "access-token",
          token_type: "Bearer",
          refresh_token: "refresh-token",
          expiry: "2099-01-01T00:00:00.000Z"
        },
        auth_method: "consumer",
        id_token_email: "pool@example.com"
      }));
      process.exit(${exitCode});
    }, 30);
  `;
}

describe("gemini sign-in", () => {
  it("shows an optional code and saves the account without API env", async () => {
    let seen: NodeJS.ProcessEnv = {};
    const login = new GeminiLogin({
      spawnLogin: (env) => {
        seen = env;
        return spawn(process.execPath, ["-e", loginScript(0, true)], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      },
      addAccount: async (authenticated) => {
        expect(authenticated).toMatchObject({
          accessToken: "access-token",
          refreshToken: "refresh-token",
          email: "pool@example.com",
        });
        return account;
      },
    });
    const started = await login.start();
    expect(started.verificationUri).toBe("https://accounts.google.com/device");
    expect(started.userCode).toBe("GEM-1234");
    expect(seen.GEMINI_API_KEY).toBeUndefined();
    expect(seen.GOOGLE_GEMINI_BASE_URL).toBeUndefined();
    expect(seen.CLOUD_CODE_URL).toBeUndefined();
    expect(seen.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    let result = await login.poll({ sessionId: started.sessionId });
    const deadline = Date.now() + 2_000;
    while (result.status === "pending" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      result = await login.poll({ sessionId: started.sessionId });
    }
    expect(result).toEqual({ status: "complete", account });
    login.dispose();
  });

  it("starts while the process is still running without a code", async () => {
    const login = new GeminiLogin({
      spawnLogin: (env) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      addAccount: async () => account,
    });
    const started = await login.start();
    expect(started.verificationUri).toBeNull();
    expect(started.userCode).toBeNull();
    login.dispose();
  });
});

it('binds reauthentication to the selected account and uses explicit isolated CLI directories',async()=>{
 let added=0;let replaced=0;
 const login=new GeminiLogin({
  spawnLogin:(env,home,args)=>{
   expect(args).toContain('--gemini-dir');expect(args[args.indexOf('--gemini-dir')+1]).toBe(home);
   expect(args).not.toContain('--app-data-dir');
   return spawn(process.execPath,['-e',loginScript(0,true)],{env,stdio:['ignore','pipe','pipe']});
  },
  addAccount:async()=>{added++;return account;},
  reauthorizeAccount:async(id,authenticated)=>{expect(id).toBe(account.id);expect(authenticated.email).toBe('pool@example.com');replaced++;return account;},
 });
 try{
  const started=await login.start(account.id);let result=await login.poll({sessionId:started.sessionId});
  const deadline=Date.now()+2000;
  while(result.status==='pending'&&Date.now()<deadline){await new Promise(r=>setTimeout(r,40));result=await login.poll({sessionId:started.sessionId});}
  expect(result).toEqual({status:'complete',account});expect(added).toBe(0);expect(replaced).toBe(1);
 }finally{login.dispose();}
});


function barrier<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve}; }
function cancellationLogin(reauthorizeAccount: NonNullable<ConstructorParameters<typeof GeminiLogin>[0]['reauthorizeAccount']>) {
 const closed=barrier<void>();
 const login=new GeminiLogin({
  spawnLogin:env=>{const child=spawn(process.execPath,['-e',loginScript(0,true)],{env,stdio:['ignore','pipe','pipe']});child.once('close',()=>closed.resolve());return child;},
  addAccount:async()=>{throw Error('Unexpected account creation');},reauthorizeAccount,
 });
 return {login,closed};
}
const syntheticAuthorization={label:'Synthetic',email:'pool@example.com',accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:null,clientId:'synthetic-client'};

it('cancel boundary: accepted cancellation before commit leaves authorization unchanged',async()=>{
 const entered=barrier<void>();const release=barrier<typeof syntheticAuthorization>();let authorization='old';
 const read=vi.spyOn(credentials,'importGeminiCredentials').mockImplementation(async()=>{entered.resolve();return release.promise;});
 const {login,closed}=cancellationLogin(async()=>{authorization='new';return account;});
 try{
  const started=await login.start(account.id);await closed.promise;
  const poll=login.poll({sessionId:started.sessionId});await entered.promise;
  expect(login.cancel({sessionId:started.sessionId})).toBe(true);
  release.resolve(syntheticAuthorization);expect((await poll).status).toBe('error');expect(authorization).toBe('old');
 }finally{read.mockRestore();login.dispose();}
});
it('cancel boundary: cancellation is declined once authorization commit has begun',async()=>{
 const entered=barrier<void>();const release=barrier<void>();let authorization='old';
 const read=vi.spyOn(credentials,'importGeminiCredentials').mockResolvedValue(syntheticAuthorization);
 const {login,closed}=cancellationLogin(async()=>{entered.resolve();await release.promise;authorization='new';return account;});
 try{
  const started=await login.start(account.id);await closed.promise;
  const poll=login.poll({sessionId:started.sessionId});await entered.promise;
  expect(login.cancel({sessionId:started.sessionId})).toBe(false);
  release.resolve();expect((await poll).status).toBe('complete');expect(authorization).toBe('new');
 }finally{release.resolve();read.mockRestore();login.dispose();}
});

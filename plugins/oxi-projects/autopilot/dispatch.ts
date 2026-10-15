import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const linkSchema = z.object({
  key: z.string(),
  sourceId: z.string(),
  project: z.string(),
  problem: z.string(),
  threadId: z.string(),
  createdAt: z.string(),
  status: z.string(),
  error: z.string().nullable(),
});
export type Link = z.infer<typeof linkSchema>;
type Input = {
  sourceId: string;
  project: string;
  problem: string;
  context: string;
  templateId: string;
};
export class Dispatcher {
 constructor(_sdk:BbPluginApi["sdk"],_store:{get:(key:string)=>Link|null;save:(link:Link)=>void}){}
 start(_input:Input):Promise<Link>{return Promise.reject(new Error("Автоматическое создание отключено: открой черновик в редакторе BB и выбери модель перед отправкой."));}
}

export type V34Blocker={code:string;message:string}
export type V34Gate={ready:boolean;environment:string;blockers:V34Blocker[];waivedBlockers:V34Blocker[];warnings:string[];waivers:any[];evaluatedAt:string;assessmentId?:string;candidateSha?:string;policy?:Record<string,any>;v33?:Record<string,any>;githubAttestation?:Record<string,any>}
export type V34Assessment={id:string;releaseId:string;candidateSha:string;pythonLock:Record<string,any>;workflow:Record<string,any>;githubAttestation:Record<string,any>;v33:Record<string,any>;policy:Record<string,any>;gate:Record<string,any>;createdAt:string;updatedAt:string;productionGate?:V34Gate}
export type V34Overview={version:string;generatedAt:string;schema:{current:number;latest:number;pending:number;databaseMode:string};policy:Record<string,any>;activeRelease?:Record<string,any>|null;latestAssessment?:V34Assessment|null;productionGate?:V34Gate|null;assessments:V34Assessment[];waivers:any[];events:any[];nonWaivable:string[]}

function csrf(){const x=document.cookie.split('; ').find(v=>v.startsWith('maghrabi_v24_csrf='));return x?decodeURIComponent(x.slice(x.indexOf('=')+1)):''}
async function parse<T>(r:Response):Promise<T>{if(r.ok)return r.json() as Promise<T>;try{const p=await r.json();throw new Error(typeof p.detail==='string'?p.detail:JSON.stringify(p.detail||p))}catch(e){if(e instanceof Error)throw e;throw new Error('تعذر تنفيذ Creator V34.')}}
async function post<T>(url:string,body:any={}):Promise<T>{const h=new Headers({'Content-Type':'application/json'});const c=csrf();if(c)h.set('X-MAGHRABI-CSRF',c);return parse<T>(await fetch(url,{method:'POST',headers:h,credentials:'include',body:JSON.stringify(body)}))}
export async function getOverviewV34(){return parse<V34Overview>(await fetch('/api/video/v34/admin/overview',{credentials:'include'}))}
export function runAssessmentV34(releaseId?:string){return post<V34Assessment>('/api/video/v34/admin/assess',releaseId?{releaseId}:{})}
export function savePolicyV34(value:Record<string,any>){return post<Record<string,any>>('/api/video/v34/admin/policy',value)}
export function createWaiverV34(value:{releaseId?:string;blockerCode:string;reason:string;hours:number}){return post<Record<string,any>>('/api/video/v34/admin/waivers',value)}
export function revokeWaiverV34(id:string){return post<Record<string,any>>(`/api/video/v34/admin/waivers/${encodeURIComponent(id)}/revoke`)}
export function evidenceUrlV34(id:string){return `/api/video/v34/admin/assessments/${encodeURIComponent(id)}/evidence`}

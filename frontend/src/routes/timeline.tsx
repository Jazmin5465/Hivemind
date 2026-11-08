import { createFileRoute } from '@tanstack/react-router';
import { useState, useLayoutEffect, useRef } from 'react';
import { Activity, Check, TriangleAlert, Droplets, GitCommitHorizontal, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDecisions } from '@/components/DecisionProvider';
import { decisionPlans, historyNodes, priorityQueue, sortHistory, type HistoryNode } from '@/lib/operations';
import { datasetNow, facilityReadings, formatTime } from '@/lib/hive-data';

export const Route=createFileRoute('/timeline')({head:()=>({meta:[{title:'Hivemind — Incident & Decision Timeline'},{name:'description',content:'Newest-first incident history, linked recoveries, forecasts and recorded operator decisions.'},{property:'og:title',content:'Hivemind — Incident & Decision Timeline'},{property:'og:description',content:'Trace each incident to its recovery and each forecast to the operator’s decision.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary_large_image'}]}),component:TimelinePage});
function TimelinePage(){
  const [mode,setMode]=useState('all'),[system,setSystem]=useState('ALL'),[type,setType]=useState('ALL');
  const {decisions,error}=useDecisions();
  const forecasts:HistoryNode[]=priorityQueue.filter(q=>q.scenario).map(q=>({id:q.id,ts:datasetNow+(q.seconds??0),title:`${q.facility} · tank fill exposure`,detail:(()=>{const f=facilityReadings.find(x=>x.id===q.facility);const r=f?.readings??[];return `Tank ${(r[0]??0).toFixed(0)}% · inflow ${(r[4]??0).toFixed(0)} bpd · ${((q.seconds??0)/3600).toFixed(1)}h to shut-in limit`;})(),kind:'forecast',category:'tank_fill',system:q.facility.slice(0,2)}));
  const actions:HistoryNode[]=decisions.map(d=>({id:d.id,ts:d.dataset_ts,recordedAt:d.created_at,title:d.title,detail:`${d.detail} · Estimated $${d.estimated_cost.toLocaleString()}`,kind:'decision',system:d.facility.slice(0,2),parentId:d.queue_id,relation:'Decision for this item'}));
  const nodes=sortHistory([...historyNodes,...forecasts,...actions]).filter(n=>(mode==='all'||(mode==='history'?n.kind!=='forecast':n.kind==='forecast'||n.kind==='decision'))&&(system==='ALL'||n.system===system)&&(type==='ALL'||(type==='pump'?n.category?.startsWith('pump'):type==='decision'?n.kind==='decision':n.category===type)));
  return <main className="mx-auto max-w-5xl p-4 md:p-6"><div className="mb-6"><h1 className="font-mono text-2xl font-bold tracking-[0.2em] text-heading-pink glow-magenta-soft">EVENT TIMELINE</h1></div>
    <div className="flex flex-wrap gap-2 border-b border-border pb-4">{([['all','All events'],['history','History'],['predict','Forecasts & decisions']] as const).map(([k,l])=><Button key={k} variant={mode===k?'secondary':'ghost'} onClick={()=>setMode(k)}>{l}</Button>)}</div>
    <div className="my-4 flex flex-wrap gap-2">{['ALL','S1','S2','S3','S4','S5'].map(s=><Button size="sm" variant={system===s?'secondary':'ghost'} key={s} onClick={()=>setSystem(s)}>{s==='ALL'?'All systems':s}</Button>)}<span className="border-l border-border"/>{([['ALL','All types'],['pipeline_leak','Leaks'],['pump','Pumps'],['recovery','Recoveries'],['decision','Decisions']] as const).map(([k,l])=><Button size="sm" key={k} variant={type===k?'secondary':'ghost'} onClick={()=>setType(k)}>{l}</Button>)}</div>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {nodes.length?<EventTree nodes={nodes}/>:<p className="py-12 text-center text-muted-foreground">No matching events.</p>}
  </main>;
}
function EventTree({nodes}:{nodes:HistoryNode[]}){
  const ref=useRef<HTMLOListElement>(null);
  const [selected,setSelected]=useState<string|null>(null);
  const [lines,setLines]=useState<{id:string;parentId:string;from:number;to:number;x:number;kind:string;lane:number}[]>([]);
  const connected=new Set<string>();
  if(selected&&nodes.some(n=>n.id===selected)){
    connected.add(selected);
    let expanded=true;
    while(expanded){
      expanded=false;
      for(const n of nodes){
        if(!n.parentId||!nodes.some(p=>p.id===n.parentId))continue;
        if(connected.has(n.id)||connected.has(n.parentId)){
          for(const id of [n.id,n.parentId])if(!connected.has(id)){connected.add(id);expanded=true;}
        }
      }
    }
  }
  useLayoutEffect(()=>{
    const list=ref.current;if(!list)return;
    const update=()=>{
      const bounds=list.getBoundingClientRect();
      const positions=new Map(Array.from(list.querySelectorAll<HTMLElement>('[data-node]')).map(el=>{
        const rect=el.getBoundingClientRect();
        return [el.dataset['node'],{y:rect.top-bounds.top+rect.height/2,x:rect.left-bounds.left+rect.width/2}] as const;
      }));
      const lanes:{start:number;end:number}[][]=[];
      setLines(nodes.flatMap(n=>{
        const from=positions.get(n.id),to=n.parentId?positions.get(n.parentId):undefined;
        if(!from||!to||!n.parentId)return [];
        const start=Math.min(from.y,to.y),end=Math.max(from.y,to.y);
        let lane=lanes.findIndex(ranges=>ranges.every(range=>end<range.start||start>range.end));
        if(lane<0){lane=lanes.length;lanes.push([]);}
        lanes[lane]?.push({start,end});
        return [{id:n.id,parentId:n.parentId,from:from.y,to:to.y,x:from.x,kind:n.kind,lane}];
      }));
    };
    update();const observer=new ResizeObserver(update);observer.observe(list);return()=>observer.disconnect();
  },[nodes]);
  return <div className="timeline-tree relative mt-7"><svg aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-full w-full overflow-visible">{[...lines].sort((a,b)=>Number(connected.has(a.id))-Number(connected.has(b.id))).map(l=>{
    const active=connected.has(l.id)&&connected.has(l.parentId);
    const laneX=Math.max(8,l.x-28-l.lane*12);
    return <path key={l.id} data-connection={l.id} data-highlighted={active} d={`M ${l.x} ${l.from} H ${laneX} V ${l.to} H ${l.x}`} fill="none" className={`timeline-connection ${active?'is-selected':''}`} stroke={active?'var(--queue-highlight)':l.kind==='decision'?'var(--ok)':'var(--primary)'} strokeOpacity={active?1:selected?0.16:0.4} strokeWidth={active?2.5:1.5} strokeDasharray={l.kind==='decision'?'4 4':undefined}/>;
  })}</svg>
    <ol ref={ref} className="relative space-y-5">{nodes.map(n=>{
      const Icon=n.kind==='decision'?GitCommitHorizontal:n.kind==='now'?Activity:n.kind==='recovery'?Check:n.category==='pipeline_leak'?Droplets:n.category==='pump_failure'?TriangleAlert:Wrench;
      const tone=n.kind==='decision'||n.kind==='recovery'?'text-ok':n.category==='pump_failure'?'text-destructive':n.kind==='forecast'?'text-muted-foreground':'text-primary';
      const linked=n.parentId&&nodes.some(p=>p.id===n.parentId);
      const active=connected.has(n.id);
      const select=()=>setSelected(current=>current===n.id?null:n.id);
      return <li key={n.id} className="timeline-row relative min-w-0"><Button variant="outline" size="icon" data-node={n.id} aria-label={`Select connections for ${n.title}`} aria-pressed={selected===n.id} onClick={select} className={`timeline-node absolute z-10 mt-4 h-6 w-6 rounded-full border border-current bg-background p-0 ${active?'timeline-selected':tone}`}><Icon className="h-3 w-3"/></Button><article className={`overflow-hidden rounded-md border bg-card ${active?'timeline-selected':'border-border'} ${n.kind==='forecast'?'border-dashed':''}`}><Button variant="ghost" aria-pressed={selected===n.id} onClick={select} className="block h-auto w-full min-w-0 whitespace-normal rounded-none border-0 bg-transparent p-4 text-left font-normal"><span className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase text-muted-foreground"><span className={n.kind==='sensor'||n.kind==='recovery'?`font-semibold ${tone}`:''}>{n.kind==='recovery'?'Recovered':n.kind==='sensor'?(n.category??'').replaceAll('_',' '):n.kind}</span><time>{formatTime(n.ts)}</time></span><span className="mt-2 block break-words text-sm font-semibold">{n.kind==='sensor'||n.kind==='recovery'?n.title.split(' · ')[0]:n.title}</span><span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">{n.detail}</span>{n.relation&&(linked?<span role="button" tabIndex={0} aria-label={`Jump to ${n.relation}`} onClick={e=>{e.stopPropagation();setSelected(n.parentId??null);ref.current?.querySelector(`[data-node="${n.parentId}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});}} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();setSelected(n.parentId??null);ref.current?.querySelector(`[data-node="${n.parentId}"]`)?.scrollIntoView({behavior:'smooth',block:'center'});}}} className={`mt-3 block w-fit cursor-pointer text-xs underline decoration-dotted underline-offset-4 hover:decoration-solid ${tone}`}>{n.relation}</span>:<span className={`mt-3 block text-xs ${tone}`}>{`${n.relation} · related node hidden by filters`}</span>)}{n.recordedAt&&<span className="mt-2 block text-[10px] text-muted-foreground">Recorded {new Date(n.recordedAt).toISOString().replace('T',' ').slice(0,16)} UTC</span>}</Button>{n.kind==='decision'&&<DecisionBreakdown id={n.id}/>}</article></li>;
    })}</ol>
  </div>;
}
function DecisionBreakdown({id}:{id:string}){
  const {decisions}=useDecisions();
  const d=decisions.find(x=>x.id===id);const item=d&&priorityQueue.find(q=>q.id===d.queue_id);
  if(!d||!item)return null;
  const plans=decisionPlans(item);const plan=plans.find(p=>p.key===d.option_key);
  if(!plan)return null;
  const cheapest=[...plans].sort((a,b)=>a.cost-b.cost)[0]??plan;
  const others=plans.filter(p=>p.key!==plan.key);
  const $=(v:number)=>`$${Math.round(v).toLocaleString()}`;
  const why=plans.length===1?'Only available response for this issue.':plan.key===cheapest.key?`Lowest estimated cost of ${plans.length} options — saves ${$(Math.min(...others.map(o=>o.cost))-plan.cost)} vs. next best.`:`Chosen over the lowest-cost option (${cheapest.label}, ${$(cheapest.cost)}) — ${$(plan.cost-cheapest.cost)} more.`;
  const rows:[string,string][]=[['Lost production',$(plan.revenueLoss)],...(plan.trips?[[`Hauling · ${plan.trips} trips · ${plan.trucks} truck${plan.trucks===1?'':'s'}`,$(plan.truckingCost)] as [string,string]]:[]),...(plan.wellIds.length?[['Wells shut in',plan.wellIds.join(', ')] as [string,string]]:[]),['Automatic shut-in',plan.shutdownHours===null?'Avoided':`After ${plan.shutdownHours.toFixed(1)}h`]];
  return <details className="border-t border-border text-xs"><summary className="cursor-pointer px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">Cost breakdown & reasoning</summary><div className="space-y-3 border-t border-border px-4 py-3"><dl className="space-y-1">{rows.map(([k,v])=><div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono">{v}</dd></div>)}<div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold"><dt>Total estimated</dt><dd className="font-mono text-ok">{$(plan.cost)}</dd></div></dl><p><span className="font-semibold">Why: </span><span className="text-muted-foreground">{why}</span></p>{others.length>0&&<ul className="space-y-0.5 text-muted-foreground">{others.map(o=><li key={o.key} className="flex justify-between gap-4"><span>vs. {o.label}</span><span className="font-mono">{$(o.cost)}</span></li>)}</ul>}</div></details>;
}

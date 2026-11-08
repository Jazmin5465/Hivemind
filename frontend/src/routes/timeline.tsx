import { createFileRoute } from '@tanstack/react-router';
import { PageTitle } from '@/components/PageTitle';
import { useState, useLayoutEffect, useRef } from 'react';
import { Activity, Check, TriangleAlert, Droplets, GitCommitHorizontal, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLive } from '@/components/LiveProvider';
import { PageBackdrop } from '@/components/PageBackdrop';
import { decisionNodes, forecastNodes, formatTime, historyNodes, planToOption, siblingOptions, sortHistory, type HistoryNode } from '@/lib/live/derive';

export const Route=createFileRoute('/timeline')({head:()=>({meta:[{title:'Hivemind — Incident & Decision Timeline'},{name:'description',content:'Newest-first incident history, linked recoveries, forecasts and recorded operator decisions.'},{property:'og:title',content:'Hivemind — Incident & Decision Timeline'},{property:'og:description',content:'Trace each incident to its recovery and each forecast to the operator’s decision.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary_large_image'}]}),component:TimelinePage});
function TimelinePage(){
  const [mode,setMode]=useState('all'),[system,setSystem]=useState('ALL'),[type,setType]=useState('ALL');
  const live=useLive();
  const error=live.status==='error'?live.error:'';
  const nodes=sortHistory([...historyNodes(live),...forecastNodes(live),...decisionNodes(live)]).filter(n=>(mode==='all'||(mode==='history'?n.kind!=='forecast':n.kind==='forecast'||n.kind==='decision'))&&(system==='ALL'||n.system===system)&&(type==='ALL'||(type==='pump'?n.category?.startsWith('pump'):type==='decision'?n.kind==='decision':n.category===type)));
  return <><PageBackdrop layers={[{ src: '/art/front-buildings.jpg', opacity: 0.08, position: 'center bottom', size: 'cover' }]}/><main className="relative z-10 mx-auto max-w-5xl p-4 md:p-6"><div className="mb-6"><PageTitle>EVENT TIMELINE</PageTitle></div>
    <div className="flex flex-wrap gap-2 border-b border-border pb-4">{([['all','All events'],['history','History'],['predict','Forecasts & decisions']] as const).map(([k,l])=><Button key={k} variant={mode===k?'secondary':'ghost'} onClick={()=>setMode(k)}>{l}</Button>)}</div>
    <div className="my-4 flex flex-wrap gap-2">{['ALL',...live.systems.map(x=>x.systemId)].map(s=><Button size="sm" variant={system===s?'secondary':'ghost'} key={s} onClick={()=>setSystem(s)}>{s==='ALL'?'All systems':s}</Button>)}<span className="border-l border-border"/>{([['ALL','All types'],['pipeline_leak','Leaks'],['pump','Pumps'],['recovery','Recoveries'],['decision','Decisions']] as const).map(([k,l])=><Button size="sm" key={k} variant={type===k?'secondary':'ghost'} onClick={()=>setType(k)}>{l}</Button>)}</div>
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    {nodes.length?<EventTree nodes={nodes}/>:<p className="py-12 text-center text-muted-foreground">No matching events.</p>}
  </main></>;
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
  const live=useLive();
  const d=live.decisions.find(x=>`decision:${x.id}`===id);
  if(!d)return null;
  const $=(v:number)=>`$${Math.round(v).toLocaleString()}`;
  const shell=(body:React.ReactNode)=><details className="border-t border-border text-xs"><summary className="cursor-pointer px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">Cost breakdown & reasoning</summary><div className="space-y-3 border-t border-border px-4 py-3">{body}</div></details>;
  if(d.kind==='inspection')return shell(<p><span className="font-semibold">Why: </span><span className="text-muted-foreground">Only available response for this issue.</span></p>);
  const plan=d.planId!=null?live.plans.find(p=>p.planId===d.planId):undefined;
  const pf=plan?live.planFacilities.find(f=>f.planId===plan.planId&&f.facilityId===d.facilityId):undefined;
  if(!plan||!pf)return null;
  // the alternatives offered next to the chosen plan (same request) — system totals
  const chosen=planToOption(live,plan);
  const others=siblingOptions(live,plan).filter(o=>o.planId!==plan.planId).map(o=>planToOption(live,o));
  const cheapest=[chosen,...others].sort((a,b)=>a.cost-b.cost)[0]??chosen;
  const why=!others.length?'Only available response for this issue.':cheapest.planId===chosen.planId||cheapest.cost>=chosen.cost?`Lowest estimated cost of ${others.length+1} options — saves ${$(Math.min(...others.map(o=>o.cost))-chosen.cost)} vs. next best.`:`Chosen over the lowest-cost option (${cheapest.label}, ${$(cheapest.cost)}) — ${$(chosen.cost-cheapest.cost)} more.`;
  const acts=live.planActions.filter(a=>a.planId===plan.planId&&a.facilityId===d.facilityId);
  const trips=acts.filter(a=>a.type==='dispatch_truck').reduce((s,a)=>s+a.trucks*a.tripsPerTruck,0);
  const trucks=acts.filter(a=>a.type==='dispatch_truck').reduce((s,a)=>s+a.trucks,0);
  const wells=acts.filter(a=>a.type==='shut_in_wells').flatMap(a=>a.wells);
  const rows:[string,string][]=[['Lost production',$(pf.shutInCost+pf.tripCost)],...(trips?[[`Hauling · ${trips} trips · ${trucks} truck${trucks===1?'':'s'}`,$(pf.truckCost)] as [string,string]]:[]),...(wells.length?[['Wells shut in',wells.join(', ')] as [string,string]]:[]),['Automatic shut-in',pf.tripsAtUnix==null?'Avoided':`After ${((pf.tripsAtUnix-plan.planStartUnix)/3600).toFixed(1)}h`]];
  return shell(<><dl className="space-y-1">{rows.map(([k,v])=><div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="font-mono">{v}</dd></div>)}<div className="flex justify-between gap-4 border-t border-border pt-1 font-semibold"><dt>Total estimated</dt><dd className="font-mono text-ok">{$(pf.cost)}</dd></div></dl><p><span className="font-semibold">Why: </span><span className="text-muted-foreground">{why}</span></p>{plan.eventIds.length>1&&<p className="text-muted-foreground">Joint {plan.systemId} plan covering {plan.eventIds.length} pump failures · total {$(plan.totalCost)}</p>}{others.length>0&&<ul className="space-y-0.5 text-muted-foreground">{others.map(o=><li key={o.key} className="flex justify-between gap-4"><span>vs. {o.label}</span><span className="font-mono">{$(o.cost)}</span></li>)}</ul>}</>);
}

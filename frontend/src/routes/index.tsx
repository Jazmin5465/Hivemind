import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ArrowRight, Droplets, Wrench, Truck, CircleAlert, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { useLive, useLiveActions } from '@/components/LiveProvider';
import { FleetPanel } from '@/components/FleetPanel';
import {
  fleets as liveFleets, fleetTrucks, fmtCountdown, formatTime, inspectOption, longTermRecommendation, nowOf, optionPlans,
  pendingPriority, planToOption, priorityQueue, temporaryRecommendations, type DecisionPlan, type Fleet, type PriorityItem,
} from '@/lib/live/derive';
import type { LiveData } from '@/lib/live/store';

export const Route = createFileRoute('/')({
  head:()=>({meta:[{title:'Hivemind — Operations Priority Queue'},{name:'description',content:'Ranked operational risks and timed remediation decisions for Avon’s water network.'},{property:'og:title',content:'Hivemind — Operations Priority Queue'},{property:'og:description',content:'Compare well shut-in and truck hauling plans, then record your decision.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary_large_image'}]}),
  component:Dashboard,
});
function Dashboard() {
  const live=useLive();
  const [selected,setSelected]=useState<PriorityItem|null>(null);
  const [fleetId,setFleetId]=useState<string|null>(null);
  const fleets=liveFleets(live);
  const openFleet=fleets.find(f=>f.id===fleetId);
  const loading=!live.ready;
  const queue=loading?[]:pendingPriority(priorityQueue(live),live.decisions);
  const status=live.status==='error'?live.error:live.status==='disconnected'?'Disconnected from the backend.':'';
  return <main className="mx-auto max-w-7xl space-y-10 p-4 md:p-6">
    <section>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-2 font-mono text-xs uppercase text-muted-foreground">Operations / Avon</p>
          <h1 className="font-mono text-2xl font-bold tracking-[0.2em] text-heading-pink glow-magenta-soft">PRIORITY QUEUE</h1>
        </div>
        <div className="text-right font-mono text-xs text-muted-foreground">
          <p>Last updated: {live.ready?formatTime(nowOf(live)):'—'}</p>
          <p className="mt-1">{queue.length} items</p>
        </div>
      </div>
      {status&&<p role="alert" className="mb-3 text-sm text-destructive">{status}</p>}
      <div role="region" aria-label="Scrollable priority queue" tabIndex={0} className="priority-queue-scroll max-h-[min(26rem,55dvh)] overflow-y-auto overscroll-contain rounded-md border border-border bg-background/40 p-3 focus-visible:outline-2 focus-visible:outline-ring">
      <ol className="grid gap-3">
        {queue.map((item,i)=>{
          const Icon=item.category==='pipeline_leak'?Droplets:item.category==='pump_degradation'?Wrench:item.category==='pump_failure'?CircleAlert:Droplets;
          return <li key={item.id} className="min-w-0"><Button variant="outline" disabled={loading} onClick={()=>setSelected(item)} aria-label={`Evaluate ${item.facility} — ${item.title}`} className="priority-card h-auto min-h-32 w-full min-w-0 flex-col items-stretch justify-start whitespace-normal rounded-md border-border bg-card p-5 text-left shadow-none transition-[border-color,box-shadow,background-color] hover:bg-secondary">
            <span className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><span className="mr-1 text-lg font-semibold tabular-nums text-primary">{String(i+1).padStart(2,'0')}</span><Icon className={item.severity==='critical'?'text-destructive':'text-muted-foreground'}/><span className={item.scenario?'':'text-destructive'}>{item.scenario?'PROACTIVE WATCH':'ACTIVE FAILURE'}</span>{item.confidence!==undefined&&<span className="ml-auto">{Math.round(item.confidence*100)}% confidence</span>}</span>
            <span className="mt-2 text-lg font-semibold">{item.title}</span><span className="break-all font-mono text-xs text-muted-foreground">{item.facility}</span>
            <span className="mt-4 font-mono text-sm uppercase tracking-wider text-muted-foreground">{item.seconds===undefined?'Status':item.scenario?'Time to shut-in if pump stops':'Time to shut-in'}</span>
            <span className={`font-mono font-semibold tabular-nums ${item.seconds===undefined?'text-2xl':'text-4xl'}`}>{item.seconds===undefined?(item.category==='pipeline_leak'?'Active leak':'Inspection needed'):fmtCountdown(item.seconds)}</span>
          </Button></li>;
        })}
      </ol>
      {loading?<p role="status" className="py-10 text-center text-muted-foreground">{live.status==='connected'?(live.dataset?'Loading live data…':'No active dataset loaded.'):'Connecting to the backend…'}</p>:!queue.length&&<p className="py-10 text-center text-muted-foreground">All queued items have a recorded decision.</p>}
      </div>
    </section>
    <section><h2 className="mb-4 text-lg font-semibold">Emergency fleets</h2><div className="flex gap-3 overflow-x-auto pb-3">{fleets.map(f=>{const busy=fleetTrucks(live,f).filter(t=>t.status!=='Standby').length;return <Button key={f.id} variant="outline" aria-expanded={fleetId===f.id} onClick={()=>setFleetId(fleetId===f.id?null:f.id)} className={`fleet-card h-auto min-w-52 flex-col items-start rounded-md border-border bg-card p-4 text-left shadow-none ${fleetId===f.id?'border-accent':''}`}><span className="font-mono text-sm">{f.name}</span><span className="flex items-center gap-2 text-sm text-muted-foreground"><Truck/>{f.trucks-busy} of {f.trucks} trucks available</span><span className="text-xs text-muted-foreground">{busy?`${busy} dispatched`:'All at yard'}</span></Button>;})}</div>{openFleet&&<FleetPanel fleet={openFleet} close={()=>setFleetId(null)}/>}</section>
    <FleetRecommendations live={live} fleets={fleets}/>
    <Dialog open={Boolean(selected)} onOpenChange={open=>{if(!open)setSelected(null);}}><DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl overflow-y-auto bg-popover">{selected&&<DecisionModal key={selected.id} item={selected} close={()=>setSelected(null)}/>}</DialogContent></Dialog>
  </main>;
}
function FleetRecommendations({live,fleets}:{live:LiveData;fleets:Fleet[]}) {
  const loads=fleets.map(f=>({id:f.id,trucks:f.trucks,standby:fleetTrucks(live,f).filter(t=>t.status==='Standby').length,failures:0}));
  const longTerm=longTermRecommendation(live);
  const recs=[...temporaryRecommendations(live,loads),...(longTerm?[longTerm]:[])];
  const group=(kind:'temporary'|'long_term',title:string)=>{const list=recs.filter(r=>r.kind===kind);return <div className="rounded-md border border-border bg-card p-4">
    <h3 className="mb-3 font-mono text-xs uppercase text-muted-foreground">{title}</h3>
    {list.length?<ul className="space-y-3">{list.map(r=><li key={r.from+r.to} className="text-sm"><p className="flex items-center gap-2 font-mono font-semibold">{r.from}<ArrowRight className="size-4 text-accent"/>{r.to}<span className="ml-auto text-xs font-normal text-muted-foreground">{r.km.toFixed(0)} km between yards</span></p><p className="mt-1 text-xs text-muted-foreground">{kind==='temporary'?'Lend 1 truck until it returns. ':'Reassign 1 truck permanently. '}{r.reason}</p></li>)}</ul>
    :<p className="text-sm text-muted-foreground">{kind==='temporary'?'Every fleet has a truck on standby.':'Truck counts match each system’s failure history.'}</p>}
  </div>;};
  return <section><h2 className="mb-4 text-lg font-semibold">Fleet recommendations</h2><div className="grid gap-3 md:grid-cols-2">{group('temporary','Right now')}{group('long_term','Long term')}</div></section>;
}
function DecisionModal({item,close}:{item:PriorityItem;close:()=>void}) {
  const live=useLive();
  const actions=useLiveActions();
  const inspect=item.category==='pipeline_leak'||item.category==='pump_degradation';
  const [requested,setRequested]=useState(inspect),[error,setError]=useState('');
  // ask the backend's planner for this system's options (or a hypothetical "pump fails now")
  useEffect(()=>{
    if(inspect)return;
    let alive=true;
    actions.requestOptions(item.systemId,item.scenario?item.facility:undefined)
      .then(()=>{if(alive)setRequested(true);})
      .catch(e=>{if(alive){setError(e instanceof Error?e.message:'Unable to compute options');setRequested(true);}});
    return()=>{alive=false;};
  },[actions,inspect,item.systemId,item.facility,item.scenario]);
  const optionRows=inspect?[]:optionPlans(live,item.systemId,item.scenario?item.facility:'');
  const plans:DecisionPlan[]=inspect?[inspectOption(item.category)]:optionRows.map(p=>planToOption(live,p));
  const best=[...plans].sort((a,b)=>a.cost-b.cost||a.trucks-b.trucks)[0];
  const [choice,setChoice]=useState<string|undefined>(undefined),[busy,setBusy]=useState(false);
  useEffect(()=>{if(choice===undefined&&best)setChoice(best.key);},[best,choice]);
  const event=item.eventId?live.events.find(e=>e.eventId===item.eventId):undefined;
  const now=nowOf(live);
  const repairHours=event?.repairEndUnix!=null?Math.max(0,(event.repairEndUnix-now)/3600):live.opsConfig?.repairHoursPumpFailure;
  const fleetSize=live.opsSystems.find(o=>o.systemId===item.systemId)?.fleetSize??0;
  const covered=optionRows[0]?.eventIds.length??0;
  const ordered=[...plans].sort((a,b)=>(a.key===best?.key?-1:b.key===best?.key?1:0));
  const impact=(p:DecisionPlan)=>{
    const parts:string[]=[];
    if(p.wellIds.length)parts.push(`Halt ${p.wellIds.join(', ')}`);
    if(p.trips>0)parts.push(`${p.trips} haul trip${p.trips===1?'':'s'}`);
    parts.push(p.shutdownHours===null?'No emergency shut-in':`Emergency shut-in in ${p.shutdownHours.toFixed(1)}h`);
    return parts.join(' · ');
  };
  const submit=async()=>{
    const plan=plans.find(p=>p.key===choice);
    if(!plan)return;
    setBusy(true);
    try{
      if(plan.key==='inspect'){if(!item.eventId)throw new Error('This alert is no longer active');await actions.sendInspector(item.eventId);}
      else if(plan.planId===undefined)throw new Error('This option is unavailable');
      else if(item.scenario)await actions.selectContingency(plan.planId);
      else await actions.approvePlan(plan.planId);
      close();
    }catch(e){setError(e instanceof Error?e.message:'Unable to save decision');}
    finally{setBusy(false);}
  };
  return <><DialogHeader className="pr-6 text-left">
      <DialogTitle className="flex flex-wrap items-center gap-2 break-words leading-relaxed">{item.facility} · Remediation plan for {item.title.toLowerCase()}</DialogTitle>
      <DialogDescription className="font-mono text-xs">{!inspect?`${(repairHours??0).toFixed(1)}h repair window · ${fleetSize} trucks in fleet${covered>1?` · joint plan for ${covered} pump failures in ${item.systemId}`:''}${item.scenario?' · contingency if this pump fails now':''}`:item.category==='pipeline_leak'?'Pipeline leak · pump continues moving water':'Pump wear · no alternate disposal needed'}</DialogDescription>
    </DialogHeader>
    {!requested||(!inspect&&!plans.length&&!error)?<p role="status" className="py-6 text-center text-sm text-muted-foreground">Calculating options with the planner…</p>:
    <RadioGroup value={choice ?? null} onValueChange={value=>setChoice(value)} className="grid gap-3 sm:grid-cols-2">
      {ordered.map(p=>{const isBest=p.key===best?.key&&p.key!=='inspect';const selected=choice===p.key;
        return <label key={p.key} htmlFor={`plan-${p.key}`} className={`cursor-pointer rounded-md border p-4 transition-colors ${isBest?'border-ok/70 bg-ok/10 shadow-[0_0_0_1px_var(--color-ok)]':selected?'border-primary/50 bg-primary/5':'border-border bg-background/40'}`}>
          <span className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 font-semibold uppercase tracking-wide">{p.label}{isBest&&<span className="flex items-center gap-1 rounded bg-ok px-2 py-0.5 text-[10px] font-bold text-background"><Check className="h-3 w-3"/>Optimal · lowest cost</span>}</span>
            <RadioGroupItem id={`plan-${p.key}`} value={p.key}/>
          </span>
          {p.key==='inspect'
            ?<span className="mt-2 block text-sm text-muted-foreground">Dispatch an inspector to the site</span>
            :<>
              <span className={`mt-3 block font-mono text-2xl ${isBest?'text-ok':''}`}>${Math.round(p.cost).toLocaleString()}</span>
              <span className="block text-xs text-muted-foreground">{p.truckingCost>0?`$${Math.round(p.revenueLoss).toLocaleString()} lost sales + $${Math.round(p.truckingCost).toLocaleString()} hauling`:'Lost sales'}</span>
              <span className="mt-2 block text-sm">{impact(p)}</span>
              {p.lines.length>1&&<span className="mt-2 block space-y-0.5 text-xs text-muted-foreground">{p.lines.map(l=><span key={l.facilityId} className="block">{l.facilityId}: {l.summary}</span>)}</span>}
              {!p.valid&&<span className="mt-2 block text-xs text-destructive">{p.errors.join('; ')}</span>}
            </>}
        </label>;})}
    </RadioGroup>}
    {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex justify-end gap-2 border-t border-border pt-4"><Button variant="ghost" onClick={close}>Cancel</Button><Button disabled={!choice||busy||!plans.length} onClick={()=>void submit()}>{busy?'Saving…':'Submit'}</Button></div>
  </>;
}

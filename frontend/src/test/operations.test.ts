import { describe, expect, it } from 'vitest';
import { simulatePlan, sortPriority, pendingPriority, sortHistory, decisionPlans, priorityQueue, type SimulationInput } from '@/lib/operations';

const input: SimulationInput = {level:50,capacity:1000,inflow:2400,hours:6,responseMin:60,cycleMin:120,trucks:2,wells:[
  {id:'A',water:1200,oil_bpd:24,gas_mcfd:24,active:true},
  {id:'B',water:1200,oil_bpd:48,gas_mcfd:0,active:true},
]};
describe('Timed pump failure economics',()=>{
  it('do nothing loses all wells revenue only after automatic shut-in',()=>{
    const plan=simulatePlan(input,[],0);
    expect(plan.shutdownHours).toBeCloseTo(4.2);
    expect(plan.revenueLoss).toBe(329); // (63 + 120) per hour * 1.8h
    expect(plan.truckingCost).toBe(0);
  });
  it('selective shut-in reduces water and loses only selected well sales until repair',()=>{
    const plan=simulatePlan(input,['A'],0);
    expect(plan.shutdownHours).toBeNull();
    expect(plan.cost).toBe(378); // 6h * ($60 oil + $3 gas)
    expect(plan.finalLevel).toBe(80);
  });
  it('charges $905 for each repeated 150-bbl pickup, using response and cycle times',()=>{
    const plan=simulatePlan({...input,level:65},[],1);
    expect(plan.trips).toBe(3); // 1h, 3h, 5h
    expect(plan.truckingCost).toBe(2715);
    expect(plan.finalLevel).toBe(80);
    expect(plan.shutdownHours).toBeNull();
  });
  it('cannot avert a shut-in before the first truck arrival',()=>{
    const plan=simulatePlan({...input,responseMin:300},[],2);
    expect(plan.shutdownHours).toBeCloseTo(4.2);
    expect(plan.trips).toBe(0);
  });
  it('supports combining early well shut-in and hauling',()=>{
    const plan=simulatePlan({...input,level:80},['A'],1);
    expect(plan.shutdownHours).toBeNull();
    expect(plan.trips).toBe(2);
    expect(plan.revenueLoss).toBe(378);
    expect(plan.truckingCost).toBe(1810);
  });
  it('never assigns more trucks than the system fleet',()=>{
    expect(simulatePlan(input,[],10)).toEqual(simulatePlan(input,[],2));
  });
  it('does not lose sales from already inactive wells',()=>{
    expect(simulatePlan({...input,wells:input.wells.map(w=>({...w,active:false}))},[],0).revenueLoss).toBe(0);
  });
});
describe('Queue and event rules',()=>{
  it('removes only the submitted item from the priority queue',()=>{
    const item=priorityQueue[0];if(!item)throw new Error('Missing fixture');
    const pending=pendingPriority(priorityQueue,[{queue_id:item.id}]);
    expect(pending.some(q=>q.id===item.id)).toBe(false);
    expect(pending).toHaveLength(priorityQueue.length-1);
  });
  it('ranks critical then high then medium, regardless of timer length',()=>{
    const base=priorityQueue[0];if(!base)throw new Error('Missing fixture');
    expect(sortPriority([{...base,id:'m',severity:'medium',seconds:1},{...base,id:'h',severity:'high',seconds:2},{...base,id:'c',severity:'critical',seconds:99}]).map(p=>p.id)).toEqual(['c','h','m']);
  });
  it('completed telemetry does not invent future leaks or damage',()=>{
    expect(priorityQueue.every(p=>p.scenario&&p.category==='tank_fill')).toBe(true);
  });
  it('uses inspection only for leaks while pumping continues',()=>{
    const item=priorityQueue[0];if(!item)throw new Error('Missing fixture');
    expect(decisionPlans({...item,category:'pipeline_leak'}).map(p=>p.key)).toEqual(['inspect']);
  });
  it('uses inspection only for pump wear',()=>{
    const item=priorityQueue[0];if(!item)throw new Error('Missing fixture');
    expect(decisionPlans({...item,category:'pump_degradation'}).map(p=>p.key)).toEqual(['inspect']);
  });
  it('orders newest event nodes first',()=>{
    expect(sortHistory([{id:'old',ts:1,title:'',detail:'',kind:'sensor'},{id:'new',ts:3,title:'',detail:'',kind:'decision'},{id:'mid',ts:2,title:'',detail:'',kind:'sensor'}]).map(n=>n.id)).toEqual(['new','mid','old']);
  });
});
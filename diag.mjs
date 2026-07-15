import { AgencyGraph } from './src/orchestration/agency-graph.ts';
import { AGENCIES } from './src/registry/agencies.ts';
function seed(){return {messages:[],tickers:['AAPL'],options:{chain:{}},next:{},investment_thesis:'',current_step:'',dataHealth:null,analystTraces:[],runtimeConfig:null,progress:undefined};}
const serial=await new AgencyGraph(AGENCIES['long-term'],{parallel:false}).execute(seed());
const parallel=await new AgencyGraph(AGENCIES['long-term'],{parallel:true}).execute(seed());
const s=serial.analystTraces.map(t=>t.analyst).sort();
const p=parallel.analystTraces.map(t=>t.analyst).sort();
console.log('SERIAL',s);
console.log('PARALLEL',p);
const sc={}; s.forEach(x=>sc[x]=(sc[x]||0)+1);
const pc={}; p.forEach(x=>pc[x]=(pc[x]||0)+1);
console.log('SERIAL counts',JSON.stringify(sc));
console.log('PARALLEL counts',JSON.stringify(pc));

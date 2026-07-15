import { describe, it } from 'vitest';
import * as fs from 'fs';
import { render, screen, fireEvent } from '@testing-library/react';
import PriceChart from '../components/PriceChart';
function makeBars(n:number){const b=[];const t0=Date.UTC(2026,0,1);for(let i=0;i<n;i++){const c=100+i;b.push({t:new Date(t0+i*3600_000).toISOString(),open:c-1,high:c+2,low:c-2,close:c,volume:1000+i});}return b;}
describe('dbg',()=>{it('legend',()=>{
  const lines:string[]=[];
  render(<PriceChart bars={makeBars(120)} />);
  const svg = screen.getByTestId('price-chart');
  const legend = () => screen.getByTestId('chart-legend').textContent ?? '';
  lines.push('INIT='+legend());
  fireEvent.pointerDown(svg,{clientX:100,clientY:50,pointerId:1});
  fireEvent.pointerDown(svg,{clientX:200,clientY:50,pointerId:2});
  fireEvent.pointerMove(svg,{clientX:50,clientY:50,pointerId:1});
  fireEvent.pointerMove(svg,{clientX:400,clientY:50,pointerId:2});
  lines.push('PINCHIN='+legend());
  fs.writeFileSync('/home/opencode/lg.txt', lines.join('\n'));
});});

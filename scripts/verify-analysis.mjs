// Focused regression checks; compile TS in memory and isolate network/neural inference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Chess } from 'chess.js';
import ts from 'typescript';

const compiled = new Map();
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
function moduleUrl(file) {
  file = resolve(file);
  if (compiled.has(file)) return compiled.get(file);
  let source = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  source = source.replace(/from ['"]([^'"]+)['"]/g, (_, specifier) => {
    const dependency = specifier.endsWith('/maiaEngine')
      ? url('export const evaluateMaiaPosition = (...args) => globalThis.analysisTestMaia(...args);')
      : specifier.startsWith('.') ? moduleUrl(resolve(dirname(file), `${specifier}.ts`)) : import.meta.resolve(specifier);
    return `from ${JSON.stringify(dependency)}`;
  });
  const result = url(source); compiled.set(file, result); return result;
}
const { analyzePerformance, classifyRatingSignal } = await import(moduleUrl('src/analysis/performanceModel.ts'));
const { moveLoss, buildReport } = await import(moduleUrl('src/analysis/reportModel.ts'));
const { profileLevels } = await import(moduleUrl('src/analysis/decisionMetrics.ts'));
const samples = (probabilities, levels = [1400,1800,2200]) => probabilities.map((probability,i) => ({rating:levels[i],probability}));
const row = probabilities => ({ mover:'white',status:'complete',maiaStatus:'complete',lossPoints:0,
  decisionWeight:1,significanceScore:1,profileProbabilities:samples(probabilities) });
const moderate = analyzePerformance([row([.2,.26,.31]),row([.2,.26,.31]),row([.2,.26,.31])], 'white',1800);
const strong = analyzePerformance([row([.01,.3,.8]),row([.01,.3,.8]),row([.01,.3,.8])], 'white',1800);
assert(moderate.rating > 1800 && moderate.rating < strong.rating);
assert.equal(analyzePerformance([row([.2,.26,.31])],'white',1800).rating,null);
assert.equal(classifyRatingSignal(samples([.1,.8,.2]),1800).direction,'non-monotonic');
for (const anchor of [1100,1200,1800,2900,3000]) {
  const levels = profileLevels(anchor);
  assert.equal(new Set(levels).size,3); assert(levels.every(n => n>=1100 && n<=3000));
  assert.equal(classifyRatingSignal(samples([.1,.3,.6],levels),anchor).direction,'upward');
}
assert.equal(moveLoss('+10.00',1000,'+7.00',700,[1000,0,0],[1000,0,0]),0);
assert(moveLoss('+0.60',60,'-1.00',-100,[400,500,100],[100,400,500])>=20);

const { runGameReview } = await import(moduleUrl('src/analysis/gameReview.ts'));
globalThis.fetch = async () => new Response('',{status:503});
const neuralCalls = [];
globalThis.analysisTestMaia = async input => {
  neuralCalls.push(input);
  const legal = new Chess(input.fen).moves({verbose:true}).map(m=>`${m.from}${m.to}${m.promotion??''}`);
  const played = input.playedMoveUci ?? legal[0];
  const p = (input.eloSelf-1000)/4000;
  return {moves:legal.map(uci=>({uci,probability:uci===played?p:(1-p)/(legal.length-1)})),
    playedMove:{uci:played,probability:p,rank:2},winProbability:.5};
};
const board=new Chess(), path=[{id:'root',fen:'start',moveUci:null,moveSan:null}];
for (const san of ['e4','e5','Nf3','Nc6','Bb5','a6','Ba4','Nf6','O-O','Be7']) {
  const m=board.move(san); path.push({id:String(path.length),fen:board.fen(),moveUci:`${m.from}${m.to}${m.promotion??''}`,moveSan:m.san});
}
const queries=[];
const query=async input=> {
  queries.push(input);
  const legal=new Chess(input.fen).moves({verbose:true});
  const candidates=legal.slice(0,3).map((m,i)=>({uci:`${m.from}${m.to}${m.promotion??''}`,scoreText:'+0.20',evalCp:20,wdl:[300-i*5,600,100+i*5],depth:12}));
  return {scoreText:'+0.20',evalCp:20,wdl:[300,600,100],bestMove:candidates[0]?.uci,pv:candidates[0]?.uci??'',depth:12,nodes:100,hasScore:true,candidates};
};
const base={path,bookResults:[],deep:true,depth:12,benchmark:1800,ratings:{white:900,black:2100},query,
  cancelled:()=>false,signal:new AbortController().signal,publish:()=>{},progress:()=>{}};
const results=await runGameReview(base);
assert.equal(results.length,10); assert(neuralCalls.length>0 && neuralCalls.length<=32);
assert(neuralCalls.every(c=>c.eloSelf>=1100&&c.eloSelf<=3000&&c.eloOppo>=1100&&c.eloOppo<=3000));
assert(results.filter(r=>r.mover==='white').every(r=>r.maiaAnchorElo===900));
assert.equal(buildReport(results,{}).players[0].profile.rating,null);
assert(queries.every(q=>q.positionCommand.includes('position fen')));
const before=queries.length;
await runGameReview({...base,path:[path[0],path[1]],bookResults:[{...results[0],status:'book',category:'book'}]});
assert.equal(queries.length,before,'book moves must never reach Stockfish');
await runGameReview({...base,cancelled:()=>true}); assert.equal(queries.length,before,'cancelled reviews must stop');
console.log(`PASS: performance ${moderate.rating}/${strong.rating}; rating boundaries; WDL; ${results.length} moves; ${neuralCalls.length} bounded Maia calls; books; cancellation.`);

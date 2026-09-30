// Focused regression checks; compile TS in memory and isolate network/neural inference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Chess } from 'chess.js';
import ts from 'typescript';

process.on('uncaughtException', error => {
  console.error(String(error.stack ?? error).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[compiled module]'));
  process.exitCode = 1;
});

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
const { classifyRatingSignal, compareMaiaLevels } = await import(moduleUrl('src/analysis/performanceModel.ts'));
const { moveLoss, buildReport } = await import(moduleUrl('src/analysis/reportModel.ts'));
const { profileLevels } = await import(moduleUrl('src/analysis/decisionMetrics.ts'));
const samples = (probabilities, levels = [1400,1800,2200]) => probabilities.map((probability,i) => ({rating:levels[i],probability}));
const row = probabilities => ({ mover:'white',status:'complete',maiaStatus:'complete',lossPoints:0,
  decisionWeight:1,significanceScore:1,profileProbabilities:samples(probabilities) });
assert.equal(classifyRatingSignal(samples([.1,.8,.2]),1800).direction,'non-monotonic');
for (const anchor of [1100,1200,1800,2900,3000]) {
  const levels = profileLevels(anchor);
  assert(levels.length>=4 && levels.length<=7); assert.equal(new Set(levels).size,levels.length);
  assert(levels.includes(anchor)); assert(levels.every(n => n>=1100 && n<=3000));
  assert.equal(classifyRatingSignal(samples(levels.map((_,i)=>.1+.5*i/(levels.length-1)),levels),anchor).direction,'upward');
}
assert.equal(classifyRatingSignal(samples([.1,.8,.1]),1800).direction,'non-monotonic');
assert.equal(classifyRatingSignal(samples([.01,.03,.08]),1800).direction,'upward','rare accurate choices can carry a signal');
const strongRows=Array.from({length:10},()=>({...row([.01,.05,.2]),maiaAnchorElo:1800}));
const profile=compareMaiaLevels(strongRows,'white',1800);
assert.equal(profile.rating,2200); assert.equal(profile.atBoundary,true);
assert.equal(compareMaiaLevels(strongRows.slice(0,3),'white',1800).rating,null);
assert.equal(compareMaiaLevels(strongRows.map(r=>({...r,lossPoints:12})),'white',1800).rating,null,'high-level style in a bad move is not strength');
const mixedRows=[...Array.from({length:3},()=>row([.02,.1,.5])),
  {...row([.5,.1,.02]),lossPoints:12},...Array.from({length:6},()=>row([.01,.8,.01]))];
assert.equal(compareMaiaLevels(mixedRows,'white',1800).rating,1800,'fit includes non-monotonic choices instead of selecting upward signals');
assert.equal(compareMaiaLevels(mixedRows,'white',1800).count,10);
assert.equal(compareMaiaLevels(Array.from({length:10},()=>row([.5,.3,.1])),'white',1800).signalCounts.downward,0,'sound decisions cannot become lower-level errors');
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
assert.equal(results.length,10); assert(neuralCalls.length>32 && neuralCalls.length<=1200);
assert(results.filter(r=>r.maiaStatus==='complete').length>=8,'deep review should cover most non-obvious moves');
assert(results.some(r=>r.profileProbabilities?.length===7),'detailed profiles use seven levels');
assert(neuralCalls.every(c=>c.eloSelf>=1100&&c.eloSelf<=3000&&c.eloOppo>=1100&&c.eloOppo<=3000));
assert(neuralCalls.every(c=>c.eloOppo===(new Chess(c.fen).turn()==='w'?2100:1100)),'opponent rating stays fixed across the mover rating grid');
assert(results.filter(r=>r.mover==='white').every(r=>r.maiaAnchorElo===900));
assert.equal(buildReport(results,{}).players[0].profile.rating,null);
assert(queries.every(q=>q.positionCommand.includes('position fen')));
const before=queries.length;
await runGameReview({...base,deep:false,path:[path[0],path[1]],bookResults:[{...results[0],status:'book',category:'book'}]});
assert.equal(queries.length,before,'quick review retains its repertoire shortcut');
await runGameReview({...base,cancelled:()=>true}); assert.equal(queries.length,before,'cancelled reviews must stop');
const deepBook=await runGameReview({...base,path:[path[0],path[1]],bookResults:[{...results[0],status:'book',category:'book',bookRepertoireName:'Test repertoire'}]});
assert.equal(deepBook[0].status,'complete','detailed review checks repertoire moves objectively');
assert.equal(deepBook[0].bookRepertoireName,'Test repertoire');
assert.equal(deepBook[0].maiaStatus,'complete','non-obvious repertoire moves still receive Maia profiles');

const opportunityRows=[{...results[0],nodeId:'gift',mover:'white',lossPoints:20,status:'complete'},
  {...results[1],nodeId:'reply',mover:'black',lossPoints:12,status:'complete'}];
const opportunityReport=buildReport(opportunityRows,{});
assert.equal(opportunityReport.players[1].opportunities.available,1);
assert.equal(opportunityReport.players[1].opportunities.missed,1);
assert.equal(opportunityReport.players[0].opportunities.escaped,1);
assert.equal(opportunityReport.players[0].averageLoss,20,'linked opportunities do not double-count impact');
assert.equal(opportunityReport.players[0].qualityScore,opportunityReport.phases[0].decisionQuality,'player and phase quality use the same index');
assert.equal(opportunityRows[1].opportunitySourceNodeId,undefined,'building a report must not mutate saved rows');
const staleReply={...opportunityRows[1],opportunitySourceNodeId:'missing',opportunityAvailable:20,opportunityTaken:true};
assert.equal(buildReport([staleReply],{}).players[1].opportunities.available,0,'a missing neighboring move invalidates saved opportunity links');
assert.equal(buildReport([opportunityRows[0],{...opportunityRows[1],lossPoints:0}],{}).players[1].opportunities.taken,1);
const quickBefore=neuralCalls.length;
await runGameReview({...base,deep:false});
assert(neuralCalls.length-quickBefore<=6,'quick mode retains its small neural budget');
const stoppedBefore=queries.length;
const cancelAt=neuralCalls.length+1;
await runGameReview({...base,cancelled:()=>neuralCalls.length>=cancelAt});
assert.equal(neuralCalls.length,cancelAt,'cancellation stops the rating grid immediately');
assert(queries.length>=stoppedBefore);
let failures=0;
globalThis.analysisTestMaia=async()=>{failures++;throw new Error('test model unavailable')};
const failed=await runGameReview(base);
assert.equal(failures,2,'repeated model failures stop further neural requests');
assert(failed.filter(r=>r.maiaEligible).every(r=>r.maiaStatus==='unavailable'));

// A rare engine move earns a difficult-find tag only after a tempting alternative is verified as bad.
const testRoot=new Chess(new Chess().fen().replace('0 1','7 20'));
const testFen=testRoot.fen(); testRoot.move('e4');
const testPath=[{id:'proof-root',fen:testFen,moveUci:null,moveSan:null},{id:'proof-e4',fen:testRoot.fen(),moveUci:'e2e4',moveSan:'e4'}];
let neuralPhase=false, alternativesPrepared=false, checkedTemptation=false;
globalThis.analysisTestMaia=async input=>{
  assert(neuralPhase && !alternativesPrepared,'neural and Stockfish enrichment must use separate worker phases');
  const legal=new Chess(input.fen).moves({verbose:true}).map(m=>`${m.from}${m.to}${m.promotion??''}`);
  const good=legal.includes('e2e4')?'e2e4':legal[0],tempting=legal.includes('a2a3')?'a2a3':legal[1];
  const p=(input.eloSelf-1000)/20000;
  return {moves:legal.map(uci=>({uci,probability:uci===good?p:uci===tempting?.88:(.12-p)/(legal.length-2)})),playedMove:null,winProbability:.5};
};
const proof=await runGameReview({...base,path:testPath,ratings:{white:1800,black:1800},
 releaseStockfish:async()=>{neuralPhase=true},prepareAlternatives:async()=>{alternativesPrepared=true},
 query:async input=>{
   assert(!neuralPhase || alternativesPrepared,'SF alternative queries require releasing Maia first');
   const alternative=input.positionCommand.endsWith(' moves a2a3');
   if(alternative) checkedTemptation=true;
   const cp=alternative?-200:0,wdl=alternative?[100,200,700]:[400,200,400];
   return {scoreText:alternative?'-2.00':'+0.00',evalCp:cp,wdl,bestMove:input.fen===testFen?'e2e4':'a7a6',pv:input.fen===testFen?'e2e4 e7e5':'a7a6',
     depth:14,nodes:100,hasScore:true,candidates:input.fen===testFen?[{uci:'e2e4',evalCp:0,scoreText:'+0.00',wdl:[400,200,400],depth:14}]:[]};
 }});
assert(checkedTemptation); assert(proof[0].greatFind,'verified narrow good mass supports a difficult find');
assert(proof[0].goodMassUpper<=.15); assert.equal(proof[0].humanAlternatives.find(m=>m.uci==='a2a3').lossPoints,30);
assert.equal(proof[0].profileProbabilities.length,7);
console.log('PASS: seven-level coverage; rare/style signals; quality gates; opportunity links; bounded quick review; cancellation; missing model; verified difficult-find alternatives; WDL.');

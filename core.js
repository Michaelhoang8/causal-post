/* Deterministic logical-clock simulation. No network connections or wall clocks. */
const clone=value=>structuredClone(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function compareVectors(left,right) {
 if(!Array.isArray(left)||!Array.isArray(right)||left.length!==right.length||left.length<1||left.length>6||
    [...left,...right].some(n=>!Number.isSafeInteger(n)||n<0))throw Error('Compare vectors of the same dimension with nonnegative integer components.');
 let less=false,greater=false;
 for(let i=0;i<left.length;i++){less ||= left[i]<right[i];greater ||= left[i]>right[i];}
 return less&&greater?'concurrent':less?'before':greater?'after':'equal';
}
function node(state,id,requireAlive=false) {
 if(typeof id!=='string'||!Object.hasOwn(state.nodes,id))throw Error('Select an existing node.');
 const result=state.nodes[id];if(requireAlive&&!result.alive)throw Error(`Node ${id} is crashed; recover it first.`);return result;
}
function link(state,from,to){node(state,from);node(state,to);if(from===to)throw Error('Choose two different nodes.');return from+'>'+to;}
function message(state,id){const result=state.messages.find(m=>m.id===id);if(!result)throw Error('Message does not exist.');if(result.status!=='pending')throw Error('Only a pending message can be delivered or dropped.');return result;}
function event(state,id,kind,label,received=null,messageId=null) {
 if(state.events.length>=200)throw Error('This scenario has reached its 200-event limit. Export or reset it.');
 const current=node(state,id,true),index=state.order.indexOf(id);
 const dependencies=current.lastEvent?[current.lastEvent]:[];
 if(received){current.vector=current.vector.map((v,i)=>Math.max(v,received.vector[i]));current.lamport=Math.max(current.lamport,received.lamport);dependencies.push(received.sendEvent);}
 current.vector[index]++;current.lamport++;
 const result={id:'e'+(state.events.length+1),node:id,kind,label,vector:[...current.vector],lamport:current.lamport,dependencies:[...new Set(dependencies)],message:messageId};
 state.events.push(result);current.lastEvent=result.id;return result;
}
const shapes={local:['type','node','label'],send:['type','from','to','label'],deliver:['type','message'],drop:['type','message'],partition:['type','from','to'],heal:['type','from','to'],crash:['type','node'],recover:['type','node']};
function validate(command) {
 if(!object(command)||typeof command.type!=='string'||!Object.hasOwn(shapes,command.type))throw Error('Unknown scenario command.');
 if(Object.keys(command).some(key=>!shapes[command.type].includes(key)))throw Error('Command contains unsupported fields.');
 if('label' in command&&(typeof command.label!=='string'||command.label.length>120))throw Error('Event label must be text of at most 120 characters.');
 if(['deliver','drop'].includes(command.type)&&(typeof command.message!=='string'||!/^m[1-9][0-9]{0,2}$/.test(command.message)))throw Error('Choose a valid message ID.');
}
export class Simulator {
 #state;#commands=[];
 constructor(order=['A','B','C']) {
  if(!Array.isArray(order)||order.length<2||order.length>6||order.some(id=>typeof id!=='string'||! /^[A-Z]$/.test(id))||new Set(order).size!==order.length)throw Error('Use 2–6 distinct single-letter uppercase node IDs.');
  this.#state={order:[...order],nodes:Object.fromEntries(order.map(id=>[id,{id,alive:true,vector:order.map(()=>0),lamport:0,lastEvent:null}])),events:[],messages:[],blocked:[]};
 }
 snapshot(){return clone({...this.#state,commandCount:this.#commands.length});}
 export(){return {format:'causal-post-v1',nodes:[...this.#state.order],commands:clone(this.#commands)};}
 apply(command) {
  validate(command);if(this.#commands.length>=512)throw Error('Scenario exceeds 512 commands.');
  // Mutations commit only after every precondition and event limit succeeds.
  const state=clone(this.#state),label=command.label?.trim()||'';
  if(command.type==='local')event(state,command.node,'local',label||'Local work');
  else if(command.type==='send'){
   link(state,command.from,command.to);node(state,command.from,true);
   if(state.messages.length>=100)throw Error('Scenario exceeds 100 messages.');
   const id='m'+(state.messages.length+1),sent=event(state,command.from,'send',label||`Send to ${command.to}`,null,id);
   state.messages.push({id,from:command.from,to:command.to,label:label||'Message',vector:[...sent.vector],lamport:sent.lamport,sendEvent:sent.id,receiveEvent:null,status:'pending'});
  }else if(command.type==='deliver'){
   const msg=message(state,command.message);node(state,msg.to,true);
   if(state.blocked.includes(link(state,msg.from,msg.to)))throw Error(`The ${msg.from} → ${msg.to} link is partitioned. Heal it before delivery.`);
   const received=event(state,msg.to,'receive',`Receive ${msg.id} from ${msg.from}`,msg,msg.id);
   msg.status='delivered';msg.receiveEvent=received.id;
  }else if(command.type==='drop')message(state,command.message).status='dropped';
  else if(command.type==='partition'||command.type==='heal'){
   const key=link(state,command.from,command.to),blocked=state.blocked.includes(key);
   if(command.type==='partition'){if(blocked)throw Error('This directed link is already partitioned.');state.blocked.push(key);}
   else{if(!blocked)throw Error('This directed link is already healthy.');state.blocked=state.blocked.filter(value=>value!==key);}
  }else{
   const current=node(state,command.node),alive=command.type==='recover';
   if(current.alive===alive)throw Error(alive?'Node is already running.':'Node is already crashed.');
   current.alive=alive;
  }
  this.#state=state;this.#commands.push(clone(command));return this.snapshot();
 }
 compare(firstId,secondId) {
  const first=this.#state.events.find(e=>e.id===firstId),second=this.#state.events.find(e=>e.id===secondId);
  if(!first||!second)throw Error('Select two recorded events.');
  return {first:clone(first),second:clone(second),relation:compareVectors(first.vector,second.vector)};
 }
}
export function importScenario(input) {
 if(typeof input==='string'){if(input.length>150000)throw Error('Scenario JSON exceeds 150,000 characters.');try{input=JSON.parse(input);}catch{throw Error('Scenario file is not valid JSON.');}}
 if(!object(input)||input.format!=='causal-post-v1'||Object.keys(input).some(key=>!['format','nodes','commands'].includes(key))||!Array.isArray(input.nodes)||!Array.isArray(input.commands)||input.commands.length>512)throw Error('Use a causal-post-v1 scenario with node IDs and at most 512 commands.');
 const result=new Simulator(input.nodes);
 for(let index=0;index<input.commands.length;index++){
  try{result.apply(input.commands[index]);}catch(error){throw Error(`Command ${index+1}: ${error.message}`);}
 }
 return result;
}
export const scenarios={
 concurrent:{format:'causal-post-v1',nodes:['A','B','C'],commands:[
  {type:'local',node:'A',label:'Draft locally'}, {type:'local',node:'A',label:'Revise draft'},
  {type:'local',node:'B',label:'Independent edit'}, {type:'send',from:'A',to:'C',label:'Share revision'},
  {type:'deliver',message:'m1'}, {type:'send',from:'C',to:'B',label:'Forward context'}, {type:'deliver',message:'m2'}]},
 partition:{format:'causal-post-v1',nodes:['A','B','C'],commands:[
  {type:'local',node:'A',label:'Prepare update'}, {type:'partition',from:'A',to:'B'},
  {type:'send',from:'A',to:'B',label:'Queued during partition'}, {type:'local',node:'B',label:'Work without update'},
  {type:'send',from:'B',to:'C',label:'Share independent work'}, {type:'deliver',message:'m2'}]},
 reorder:{format:'causal-post-v1',nodes:['A','B','C'],commands:[
  {type:'send',from:'A',to:'B',label:'First message'}, {type:'send',from:'A',to:'B',label:'Second message'},
  {type:'deliver',message:'m2'}, {type:'local',node:'C',label:'Unrelated work'}]}
};

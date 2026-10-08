// Integration test (see test/run.mjs). Talks to a real broker process with a fake Chrome extension.
import WebSocket from "ws";
import { existsSync } from "node:fs";
const B = process.env.BASE_URL; let cookie="";
const api=async(m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{"content-type":"application/json","x-requested-with":"dashboard",cookie,...h},body:b?JSON.stringify(b):undefined});const sc=r.headers.get("set-cookie");if(sc)cookie=sc.split(";")[0];return{s:r.status,j:await r.json().catch(()=>null)}};
const ck=(n,c,x="")=>console.log((c?"PASS ":"FAIL ")+n+(c?"":" "+JSON.stringify(x)));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await api("POST","/api/auth/login",{email:"admin@x.io",password:"adminpass1"});
const mk=async(label)=>{const pc=await api("POST","/api/devices/pairing");const j=await (await fetch(B+"/api/device/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:pc.j.code,label})})).json();
 const ws=new WebSocket(B.replace(/^http/, "ws") + "/ws");const seen=[];ws.on("message",raw=>{const m=JSON.parse(raw);if(m.type==="generate_image"){seen.push(m);ws.send(JSON.stringify({type:"started",id:m.id}));ws.send(JSON.stringify({type:"result",id:m.id,text:"reply to: "+m.prompt,images:[],conversationUrl:m.conversationUrl||"https://chatgpt.com/c/abc-123"}));}});
 await new Promise(r=>ws.on("open",r));ws.send(JSON.stringify({type:"auth",token:j.deviceToken}));return{ws,seen,id:j.deviceId}};
const A=await mk("A"),Bd=await mk("B"); await sleep(300);
const k=(await api("POST","/api/keys",{name:"t"})).j.key;
// first job pinned to device B, new chat
const j1=await api("POST","/api/jobs",{prompt:"hello",mode:"text",target:{deviceId:Bd.id}}); await sleep(600);
const d1=(await api("GET","/api/jobs/"+j1.j.id)).j;
ck("chat url captured from extension",d1.chatUrl==="https://chatgpt.com/c/abc-123",d1);
// follow up
const f=await api("POST",`/api/jobs/${j1.j.id}/followup`,{prompt:"and then?"}); ck("followup accepted",f.s===202,f); await sleep(600);
const d2=(await api("GET","/api/jobs/"+f.j.id)).j;
const last=Bd.seen[Bd.seen.length-1];
ck("followup runs on same device with conversationUrl",last.prompt==="and then?"&&last.conversationUrl==="https://chatgpt.com/c/abc-123"&&A.seen.length===0,{last,aSeen:A.seen.length});
ck("followup linked to parent",d2.parentId===j1.j.id&&d2.state==="succeeded"&&d2.text==="reply to: and then?",d2);
// v1 followup with wait
const v=await (await fetch(B+`/v1/jobs/${f.j.id}/followup?wait=10`,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+k},body:JSON.stringify({prompt:"third"})})).json();
ck("v1 followup",v.state==="succeeded"&&v.text==="reply to: third",v);
// mcp continue_chat
const H={"content-type":"application/json",accept:"application/json, text/event-stream",authorization:"Bearer "+k};
const mcp=async b=>await (await fetch(B+"/mcp",{method:"POST",headers:H,body:JSON.stringify(b)})).text();
await mcp({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"t",version:"0"}}});
const tc=await mcp({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"continue_chat",arguments:{jobId:v.id,prompt:"via mcp"}}});
ck("mcp continue_chat",tc.includes("reply to: via mcp")&&tc.includes("job id:"),tc.slice(0,300));
// no-url job cannot continue
const j3=await api("POST","/api/jobs",{prompt:"x",mode:"text"});await sleep(500);
// (fake device always returns a url, so simulate by checking error path on unknown job)
ck("followup on foreign/unknown job 404",(await api("POST","/api/jobs/nope/followup",{prompt:"x"})).s===404);
// delete
const del=await api("DELETE","/api/jobs/"+f.j.id); ck("delete job",del.s===200);
ck("deleted job gone",(await api("GET","/api/jobs/"+f.j.id)).s===404);
const kid=(await api("GET","/api/jobs/"+v.id)).j; ck("children survive parent deletion",kid.state==="succeeded");
ck("v1 delete",(await fetch(B+"/v1/jobs/"+v.id,{method:"DELETE",headers:{authorization:"Bearer "+k}})).status===200);
process.exit(0);

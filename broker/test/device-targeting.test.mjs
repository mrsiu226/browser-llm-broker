// Integration test (see test/run.mjs). Talks to a real broker process with a fake Chrome extension.
import WebSocket from "ws";
const B = process.env.BASE_URL; let cookie="";
const api=async(m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{"content-type":"application/json","x-requested-with":"dashboard",cookie,...h},body:b?JSON.stringify(b):undefined});const sc=r.headers.get("set-cookie");if(sc)cookie=sc.split(";")[0];return{s:r.status,j:await r.json().catch(()=>null)}};
await api("POST","/api/auth/login",{email:"admin@x.io",password:"adminpass1"});
const mk=async(label)=>{const pc=await api("POST","/api/devices/pairing");const r=await fetch(B+"/api/device/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:pc.j.code,label})});const j=await r.json();
 const ws=new WebSocket(B.replace(/^http/, "ws") + "/ws");const hits=[];ws.on("message",raw=>{const m=JSON.parse(raw);if(m.type==="generate_image"){hits.push(m.id);ws.send(JSON.stringify({type:"started",id:m.id}));ws.send(JSON.stringify({type:"result",id:m.id,text:label,images:[]}));}});
 await new Promise(r=>ws.on("open",r));ws.send(JSON.stringify({type:"auth",token:j.deviceToken}));return{ws,hits,id:j.deviceId}};
const A=await mk("Work Laptop"),Bd=await mk("Home PC");await new Promise(r=>setTimeout(r,300));
const k=(await api("POST","/api/keys",{name:"t"})).j.key;
const ask=async(target)=>(await (await fetch(B+"/v1/jobs?wait=10",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+k},body:JSON.stringify({prompt:"x",mode:"text",target})})).json());
const r1=await ask({device:"home pc"}); console.log(r1.text==="Home PC"?"PASS label (case-insens)":"FAIL "+JSON.stringify(r1));
const r2=await ask({deviceId:A.id}); console.log(r2.text==="Work Laptop"?"PASS id":"FAIL");
const r3=await fetch(B+"/v1/jobs",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+k},body:JSON.stringify({prompt:"x",target:{device:"nope"}})}); console.log(r3.status===404?"PASS unknown device 404":"FAIL "+r3.status);
process.exit(0);

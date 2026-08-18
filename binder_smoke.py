import sys,time
sys.path.insert(0,"backend")
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app.binder_api import _jobs,build_binder_router
from app.config import Settings
from app.models import SourceRecord
TEXT="[Page 1]\n"+"\n".join([
"A geometric progression is a sequence where each term uses a constant common ratio.",
"The common ratio is found by dividing a term by the preceding term.",
"The nth term formula allows any term to be calculated without listing earlier terms.",
"A finite geometric series uses the first term, ratio, and number of terms.",
"An infinite geometric series converges when the absolute common ratio is below one.",
"Compound growth can be represented by a geometric progression because changes multiply repeatedly."])
async def extract(content,filename,content_type,deep):
 return SourceRecord(id="temporary",filename=filename,content_type=content_type,size=len(content),text=TEXT,labels=["Page 1"])
app=FastAPI(); app.include_router(build_binder_router(extract,Settings(_env_file=None,demo_mode=True,s3_bucket="",table_name="")))
with TestClient(app) as c:
 b=c.post("/api/binders",json={"name":"Mathematics"}).json(); assert b["id"]
 made=c.post(f"/api/binders/{b['id']}/sources",json={"files":[{"fileName":"gp.pdf","sizeBytes":100}]}).json()["created"][0]
 assert c.put(made["uploadUrl"],content=b"%PDF-1.4 smoke").status_code==204
 assert c.post(f"/api/binders/{b['id']}/sources/{made['id']}/commit").status_code==200
 for _ in range(100):
  status=c.get(f"/api/sources/{made['id']}/status").json()
  if status["status"]!="processing": break
  time.sleep(.02)
 assert status["status"]=="ready",status
 job=c.post(f"/api/binders/{b['id']}/generate").json()["jobId"]
 for _ in range(200):
  if _jobs[job]["status"]!="running": break
  time.sleep(.02)
 assert _jobs[job]["status"]=="ready",_jobs[job]
 result=c.get(f"/api/binders/{b['id']}").json(); assert result["chunks"][0]["sourceId"]==made["id"]
 assert c.get(f"/api/sources/{made['id']}/content").status_code==200
 assert c.delete(f"/api/sources/{made['id']}").status_code==204
 assert c.delete(f"/api/binders/{b['id']}").status_code==204
print("binder lifecycle smoke: passed")
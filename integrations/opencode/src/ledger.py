import hashlib, json, os, sqlite3, sys, time
from pathlib import Path

a = json.load(sys.stdin)
path = Path(a['path']).expanduser()
path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chmod(path.parent, 0o700)
db = sqlite3.connect(path, timeout=5)
os.chmod(path, 0o600)
db.execute('CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, session TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, refs TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_after REAL NOT NULL DEFAULT 0, created REAL NOT NULL, updated REAL NOT NULL)')
db.execute('CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, cwd TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL, review_id TEXT)')
db.execute('CREATE TABLE IF NOT EXISTS capture_turns (project TEXT NOT NULL,cwd TEXT NOT NULL,session TEXT NOT NULL,message TEXT NOT NULL,PRIMARY KEY(project,cwd,session,message))')
if 'remote_ordinal' not in {row[1] for row in db.execute('PRAGMA table_info(capture_turns)')}:
 db.execute('ALTER TABLE capture_turns ADD COLUMN remote_ordinal INTEGER')
db.execute('CREATE TABLE IF NOT EXISTS capture_settings_cache (project TEXT PRIMARY KEY,interval INTEGER NOT NULL)')
if 'review_id' not in {row[1] for row in db.execute('PRAGMA table_info(outbox)')}:
 db.execute('ALTER TABLE outbox ADD COLUMN review_id TEXT')
now=time.time(); project=a['project']; cwd=a['cwd']; op=a['op']
db.execute("UPDATE reviews SET status='expired', data='{}', refs='[]', updated=? WHERE status IN ('collecting','pending','unresolved') AND created<?", (now, now-604800))
# Clear expired undelivered content but retain a visible record of the failure.
expired=[row[0] for row in db.execute("SELECT DISTINCT review_id FROM outbox WHERE project=? AND cwd=? AND action!='expired' AND created<? AND review_id IS NOT NULL",(project,cwd,now-604800))]
for review_id in expired:
 db.execute("UPDATE reviews SET status='expired',data='{}',refs='[]',updated=? WHERE id=? AND project=? AND cwd=?",(now,review_id,project,cwd))
 db.execute("UPDATE outbox SET action='expired',payload='{}' WHERE project=? AND cwd=? AND review_id=?",(project,cwd,review_id))
db.execute("UPDATE outbox SET action='expired',payload='{}' WHERE project=? AND cwd=? AND action!='expired' AND created<? AND review_id IS NULL",(project,cwd,now-604800))
def get(id):
 row=db.execute('SELECT id,status,data,refs,session,message,attempts FROM reviews WHERE id=? AND project=? AND cwd=?',(id,project,cwd)).fetchone()
 if not row: raise ValueError('Review is not available in this project and workspace')
 return dict(zip(('id','status','data','refs','session','message','attempts'),(row[0],row[1],json.loads(row[2]),json.loads(row[3]),row[4],row[5],row[6])))
def delay(n): return min(3600,300*2**min(n,4))
if op=='start':
 scope=hashlib.sha256(cwd.encode()).hexdigest()
 id=hashlib.sha256(json.dumps(['opencode',project,scope,a['session'],a['message']]).encode()).hexdigest() if a.get('mirror') else hashlib.sha256(json.dumps([project,cwd,a['session'],a['message']],ensure_ascii=False).encode()).hexdigest()[:32]
 # A subsequent user message ends any unacknowledged turn in the same session.
 inserted=db.execute("INSERT OR IGNORE INTO reviews(id,project,cwd,session,message,status,data,refs,created,updated) VALUES(?,?,?,?,?,'collecting',?,'[]',?,?)",(id,project,cwd,a['session'],a['message'],json.dumps({'user':a.get('user','')[:12000]},ensure_ascii=False),now,now)).rowcount
 if inserted: db.execute("UPDATE reviews SET status='unresolved',retry_after=?,updated=? WHERE project=? AND cwd=? AND session=? AND message<>? AND status='collecting'",(now+300,now,project,cwd,a['session'],a['message']))
 result=get(id)
elif op=='get': result=get(a['id'])
elif op=='ref':
 row=get(a['id'])
 if row['status'] not in ('collecting','pending','unresolved'): raise ValueError('Review already complete')
 refs=list(dict.fromkeys(row['refs']+[a['ref']]))
 db.execute('UPDATE reviews SET refs=?,updated=? WHERE id=?',(json.dumps(refs),now,a['id'])); result=get(a['id'])
elif op=='complete':
 row=get(a['id']); status=a['status']; refs=a.get('references',[]); drafts=a.get('drafts',[]); reason=a.get('reason','')
 if row['status'] not in ('collecting','pending','unresolved'): raise ValueError('Review already complete')
 if status not in ('saved','no_memory','pending'): raise ValueError('Invalid status')
 if not isinstance(refs,list) or any(ref not in row['refs'] for ref in refs): raise ValueError('References must be verified')
 if status=='saved' and not refs: raise ValueError('saved requires verified references')
 if status=='no_memory' and not reason: raise ValueError('no_memory requires a reason')
 if status=='pending' and (not isinstance(drafts,list) or not drafts or len(drafts)>20 or len(json.dumps(drafts))>100000 or any(not isinstance(d,dict) or not str(d.get('title','')).strip() or not str(d.get('content','')).strip() for d in drafts)): raise ValueError('pending requires bounded title/content drafts')
 data={'reason':reason,'references':refs}
 if status=='pending': data['drafts']=[{'title':d['title'],'content':d['content']} for d in drafts]
 attempts=row['attempts']+(status=='pending')
 db.execute('UPDATE reviews SET status=?,data=?,attempts=?,retry_after=?,updated=? WHERE id=?',(status,json.dumps(data,ensure_ascii=False),attempts,now+delay(attempts-1) if status=='pending' else 0,now,a['id'])); result=get(a['id'])
elif op=='idle':
 db.execute("UPDATE reviews SET status='unresolved',retry_after=?,updated=? WHERE project=? AND cwd=? AND session=? AND status='collecting'",(now+300,now,project,cwd,a['session'])); result={'ok':True}
elif op=='pending':
 rows=db.execute("SELECT id,attempts FROM reviews WHERE project=? AND cwd=? AND id<>? AND status IN ('pending','unresolved') AND retry_after<=? ORDER BY created LIMIT 3",(project,cwd,a['id'],now)).fetchall()
 result=[get(row[0]) for row in rows]
 for id,n in rows: db.execute('UPDATE reviews SET attempts=attempts+1,retry_after=?,updated=? WHERE id=?',(now+delay(n),now,id))
elif op=='outbox_list':
 result=[{'seq':seq,'action':action,'payload':json.loads(payload)} for seq,action,payload in db.execute("SELECT seq,action,payload FROM outbox WHERE project=? AND cwd=? AND action!='expired' ORDER BY seq LIMIT 100",(project,cwd)).fetchall()]
elif op=='outbox_ack':
 db.execute('DELETE FROM outbox WHERE seq=? AND project=? AND cwd=?',(a['seq'],project,cwd)); result={'ok':True}
elif op=='outbox_status':
 result={'pending':db.execute("SELECT count(*) FROM outbox WHERE project=? AND cwd=? AND action!='expired'",(project,cwd)).fetchone()[0], 'expired':db.execute("SELECT count(*) FROM outbox WHERE project=? AND cwd=? AND action='expired'",(project,cwd)).fetchone()[0]}
elif op=='import_pending':
 row=a['row']
 if row.get('status') not in ('pending','unresolved') or not isinstance(row.get('data'),dict) or not isinstance(row.get('verified_references'),list): raise ValueError('Invalid remote pending review')
 db.execute('INSERT OR IGNORE INTO reviews(id,project,cwd,session,message,status,data,refs,attempts,retry_after,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(row['id'],project,cwd,row['session'],row['turn'],row['status'],json.dumps(row['data'],ensure_ascii=False),json.dumps(row['verified_references'],ensure_ascii=False),row.get('attempts',0),0,row.get('created',now),now)); result=get(row['id'])
elif op=='turn':
 inserted=db.execute('INSERT OR IGNORE INTO capture_turns(project,cwd,session,message) VALUES(?,?,?,?)',(project,cwd,a['session'],a['message'])).rowcount
 cached=db.execute('SELECT interval FROM capture_settings_cache WHERE project=?',(project,)).fetchone()
 result={'interval':cached[0] if cached else a['interval']}
elif op=='set_interval':
 if type(a.get('interval')) is not int or not 1<=a['interval']<=100: raise ValueError('Invalid interval')
 db.execute('INSERT INTO capture_settings_cache VALUES(?,?) ON CONFLICT(project) DO UPDATE SET interval=excluded.interval',(project,a['interval'])); result={'interval':a['interval']}
elif op=='set_turn_state':
 if type(a.get('interval')) is not int or not 1<=a['interval']<=100 or type(a.get('ordinal')) is not int or a['ordinal']<1: raise ValueError('Invalid remote turn state')
 db.execute('INSERT INTO capture_settings_cache VALUES(?,?) ON CONFLICT(project) DO UPDATE SET interval=excluded.interval',(project,a['interval']))
 db.execute('UPDATE capture_turns SET remote_ordinal=? WHERE project=? AND cwd=? AND session=? AND message=?',(a['ordinal'],project,cwd,a['session'],a['message'])); result={'ok':True}
elif op=='get_interval':
 cached=db.execute('SELECT interval FROM capture_settings_cache WHERE project=?',(project,)).fetchone(); ordinal=db.execute('SELECT remote_ordinal FROM capture_turns WHERE project=? AND cwd=? AND session=? AND message=?',(project,cwd,a['session'],a['message'])).fetchone(); result={'interval':cached[0] if cached else a['interval'],'ordinal':ordinal[0] if ordinal else None}
else: raise ValueError('Invalid operation')
if a.get('mirror') and op=='turn' and inserted:
 db.execute('INSERT INTO outbox(project,cwd,action,payload,created,review_id) VALUES(?,?,?,?,?,NULL)',(project,cwd,'turn',json.dumps({'session':a['session'],'turn':a['message'],'interval':a['interval']}),now))
if a.get('mirror') and op in ('start','ref','complete','idle') and (op!='start' or inserted):
 if op in ('ref','complete'):
  start_payload={'review_id':a['id'],'expected_id':a['id'],'session':result['session'],'turn':result['message']}
  db.execute('INSERT INTO outbox(project,cwd,action,payload,created,review_id) VALUES(?,?,?,?,?,?)',(project,cwd,'start',json.dumps(start_payload,ensure_ascii=False),now,a['id']))
  if op=='complete':
   for reference in a.get('references',[]): db.execute('INSERT INTO outbox(project,cwd,action,payload,created,review_id) VALUES(?,?,?,?,?,?)',(project,cwd,'ref',json.dumps({'id':a['id'],'reference':reference},ensure_ascii=False),now,a['id']))
 if op=='start': payload={'review_id':id,'session':a['session'],'turn':a['message'],'expected_id':id,'data':{'user':a.get('user','')[:12000]}}
 elif op=='ref': payload={'id':a['id'],'reference':a['ref']}
 elif op=='complete':
  payload={'id':a['id'],'status':a['status'],'data':{'reason':a.get('reason',''),'references':a.get('references',[])}}
  if a['status']=='pending': payload['data']['drafts']=a.get('drafts',[])
 else: payload={'session':a['session']}
 review_id=id if op=='start' else a.get('id') if op in ('ref','complete') else None
 db.execute('INSERT INTO outbox(project,cwd,action,payload,created,review_id) VALUES(?,?,?,?,?,?)',(project,cwd,op,json.dumps(payload,ensure_ascii=False),now,review_id))
db.commit(); print(json.dumps(result,ensure_ascii=False))

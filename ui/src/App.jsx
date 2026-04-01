import { useState, useEffect, useCallback, useRef } from 'react';

const API = 'http://localhost:3001/api';
const api = {
  get:    url         => fetch(`${API}${url}`).then(r => r.json()),
  post:   (url, body) => fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()),
  delete: url         => fetch(`${API}${url}`, { method: 'DELETE' }).then(r => r.json()),
};

const statusColor = i => !i.tmuxRunning ? '#555' : !i.kibanaHealth.up ? '#e87070' : i.kibanaHealth.status === 'available' ? '#3ddc84' : '#ffd166';
const statusLabel = i => !i.tmuxRunning ? 'no session' : !i.kibanaHealth.up ? (i.kibanaHealth.status === 'timeout' ? 'starting…' : 'kibana down') : i.kibanaHealth.status ?? 'up';
const typeColor   = t => t === 'permanent' ? '#4db8ff' : '#ffd166';

function Dot({ color, pulse }) {
  return <span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:color, flexShrink:0, animation: pulse ? 'pulse 1.6s ease-in-out infinite' : 'none' }} />;
}

function Badge({ label, color, bg, border }) {
  return <span style={{ fontSize:10, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color, background:bg, border:`1px solid ${border}`, borderRadius:4, padding:'2px 7px' }}>{label}</span>;
}

function ActionBtn({ label, onClick, danger, disabled, loading }) {
  return (
    <button onClick={onClick} disabled={disabled || loading} style={{
      background:'none', border:`1px solid ${danger ? 'rgba(232,112,112,0.4)' : 'rgba(255,255,255,0.12)'}`,
      borderRadius:5, color: danger ? '#e87070' : '#8fa8c0', fontSize:11, padding:'4px 10px',
      cursor: disabled||loading ? 'not-allowed' : 'pointer', opacity: disabled||loading ? 0.45 : 1,
      fontFamily:'JetBrains Mono, monospace', transition:'all 0.15s', whiteSpace:'nowrap',
    }}>{loading ? '…' : label}</button>
  );
}

function Row({ k, v, vc }) {
  return (
    <div style={{ display:'flex', gap:8, fontSize:11 }}>
      <span style={{ color:'#3d5060', minWidth:52 }}>{k}</span>
      <span style={{ color: vc ?? '#8fa8c0', fontFamily:'JetBrains Mono, monospace' }}>{v}</span>
    </div>
  );
}

function SwitchButton({ onSwitch, busy }) {
  const [open, setOpen]       = useState(false);
  const [input, setInput]     = useState('');
  const [branches, setBranches] = useState([]);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    api.get('/git/branches').then(r => setBranches(r.branches ?? []));
    const close = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const filtered = branches.filter(b => b.includes(input) && b !== 'main').slice(0, 8);

  return (
    <div ref={ref} style={{ position:'relative' }}>
      <ActionBtn label="switch branch" onClick={() => setOpen(o => !o)} loading={busy} />
      {open && (
        <div style={{ position:'absolute', bottom:'110%', left:0, background:'#0f1318', border:'1px solid #253040', borderRadius:8, padding:8, minWidth:220, zIndex:100, boxShadow:'0 8px 32px rgba(0,0,0,0.5)' }}>
          <input autoFocus placeholder="filter branches…" value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && input) { onSwitch(input); setOpen(false); } }}
            style={{ width:'100%', background:'#060810', border:'1px solid #253040', borderRadius:5, color:'#ddeeff', fontSize:11, padding:'5px 8px', fontFamily:'JetBrains Mono, monospace', marginBottom:6, outline:'none' }}
          />
          {filtered.map(b => (
            <div key={b} onMouseDown={e => { e.preventDefault(); onSwitch(b); setOpen(false); }}
              style={{ padding:'5px 8px', fontSize:11, color:'#8fa8c0', cursor:'pointer', borderRadius:4, fontFamily:'JetBrains Mono, monospace' }}
              onMouseEnter={e => e.currentTarget.style.background='#151b24'}
              onMouseLeave={e => e.currentTarget.style.background='none'}
            >{b}</div>
          ))}
          {filtered.length === 0 && input && <div style={{ fontSize:11, color:'#3d5060', padding:'4px 8px' }}>press enter to use "{input}"</div>}
        </div>
      )}
    </div>
  );
}

function AgentPanel({ name, onApplyDone }) {
  const [phase, setPhase] = useState('idle'); // idle | analyzing | done | applying | applied
  const [agentText, setAgentText] = useState('');
  const [proposal, setProposal] = useState(null);
  const [error, setError] = useState(null);
  const preRef = useRef(null);

  function scrollToBottom() {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }

  function consumeSse(url, onText, onDone, onError) {
    fetch(`http://localhost:3001/api${url}`, { method: 'POST' }).then(res => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      function read() {
        reader.read().then(({ done, value }) => {
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const eventLine = part.split('\n').find(l => l.startsWith('event:'));
            const dataLine  = part.split('\n').find(l => l.startsWith('data:'));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice(7).trim();
            const data  = JSON.parse(dataLine.slice(5).trim());
            if (event === 'agent_text' || event === 'agent_result') onText(data.text ?? '');
            if (event === 'done') onDone(data);
            if (event === 'error') onError(data.message);
          }
          read();
        });
      }
      read();
    }).catch(e => onError(String(e)));
  }

  function analyze() {
    setPhase('analyzing');
    setAgentText('');
    setProposal(null);
    setError(null);
    consumeSse(
      `/instances/${encodeURIComponent(name)}/analyze`,
      text => { setAgentText(t => t + text); requestAnimationFrame(scrollToBottom); },
      data => { setPhase('done'); setProposal(data.proposal); requestAnimationFrame(scrollToBottom); },
      msg  => { setPhase('idle'); setError(msg); }
    );
  }

  function apply() {
    setPhase('applying');
    setAgentText(t => t + '\n\n— Applying changes —\n\n');
    consumeSse(
      `/instances/${encodeURIComponent(name)}/apply`,
      text => { setAgentText(t => t + text); requestAnimationFrame(scrollToBottom); },
      ()   => { setPhase('applied'); onApplyDone(); },
      msg  => { setPhase('done'); setError(msg); }
    );
  }

  return (
    <div style={{ margin:'0 16px 12px', background:'#060810', border:'1px solid #253040', borderRadius:6, overflow:'hidden' }}>
      <div style={{ padding:'6px 10px', borderBottom:'1px solid #1e2836', display:'flex', alignItems:'center', gap:8 }}>
        <span style={{ fontSize:9, color:'#3d5060', letterSpacing:'0.1em', textTransform:'uppercase', flex:1 }}>
          {phase === 'idle' ? 'claude analysis' : phase === 'analyzing' ? 'analyzing…' : phase === 'applying' ? 'applying changes…' : phase === 'applied' ? 'changes applied ✓' : 'analysis ready'}
        </span>
        {phase === 'idle' && <ActionBtn label="analyze logs" onClick={analyze} />}
        {phase === 'done' && proposal && <>
          <ActionBtn label="re-analyze" onClick={analyze} />
          <ActionBtn label="apply changes" onClick={apply} />
        </>}
        {phase === 'done' && !proposal && <ActionBtn label="re-analyze" onClick={analyze} />}
      </div>

      {(agentText || error) && (
        <pre ref={preRef} style={{ margin:0, padding:'8px 10px', fontSize:10, color:'#c8d8e8', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:360, overflowY:'auto', lineHeight:1.6, textAlign:'left', width:'100%' }}>
          {error ? <span style={{ color:'#e87070' }}>{error}</span> : agentText}
        </pre>
      )}

      {phase === 'done' && proposal && (
        <div style={{ padding:'8px 10px', borderTop:'1px solid #1e2836' }}>
          <div style={{ fontSize:10, color:'#ffd166', marginBottom:6, fontWeight:600 }}>{proposal.summary}</div>
          <div style={{ fontSize:10, color:'#8fa8c0', marginBottom:8 }}>{proposal.rootCause}</div>
          {proposal.proposedChanges.map((c, i) => (
            <div key={i} style={{ marginBottom:8, padding:'6px 8px', background:'#0a1018', borderRadius:4, border:'1px solid #1e2836' }}>
              <div style={{ fontSize:10, color:'#3ddc84', marginBottom:4 }}>
                {i + 1}. {c.description}
              </div>
              <div style={{ fontSize:9, color:'#3d5060', fontFamily:'JetBrains Mono, monospace' }}>
                {c.file.replace('/Users/miguelmartin/kibana-manager/', '')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LogPanel({ name, visible }) {
  const [logs, setLogs] = useState([]);
  const [showAgent, setShowAgent] = useState(false);
  const preRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!visible) { clearInterval(intervalRef.current); return; }
    const fetch = () => api.get(`/instances/${encodeURIComponent(name)}/logs`).then(r => {
      setLogs(prev => {
        const next = r.logs ?? [];
        if (preRef.current) {
          const el = preRef.current;
          const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (isAtBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
        }
        return next;
      });
    });
    fetch();
    intervalRef.current = setInterval(fetch, 2000);
    return () => clearInterval(intervalRef.current);
  }, [visible, name]);

  if (!visible) return null;
  return (
    <>
      <div style={{ margin:'0 16px 12px', background:'#060810', border:'1px solid #1e2836', borderRadius:6, overflow:'hidden' }}>
        <div style={{ padding:'4px 10px', borderBottom:'1px solid #1e2836', display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:9, color:'#3d5060', letterSpacing:'0.1em', textTransform:'uppercase', flex:1 }}>process logs · auto-refresh 2s</span>
          <ActionBtn label={showAgent ? 'hide agent' : '✦ fix with claude'} onClick={() => setShowAgent(a => !a)} />
        </div>
        <pre ref={preRef} style={{ margin:0, padding:'8px 10px', fontSize:10, color:'#4db8ff', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:320, overflowY:'auto', lineHeight:1.6, textAlign:'left', width:'100%' }}>
          {logs.length === 0 ? <span style={{ color:'#3d5060' }}>no logs yet…</span> : logs.join('\n')}
        </pre>
      </div>
      {showAgent && <AgentPanel name={name} onApplyDone={() => {}} />}
    </>
  );
}

function InstanceCard({ inst, onRefresh }) {
  const [busy,     setBusy]     = useState(null);
  const [log,      setLog]      = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const sc = statusColor(inst);
  const isPermanent = inst.type === 'permanent';
  const isFeat = inst.name === 'kibana-feat';

  async function act(action, fn) {
    setBusy(action); setLog('');
    try { const res = await fn(); setLog(res.output ?? res.error ?? 'done'); }
    catch (e) { setLog(String(e)); }
    finally { setBusy(null); onRefresh(); }
  }

  return (
    <div style={{ background:'#0f1318', border:'1px solid #1e2836', borderTop:`2px solid ${sc}`, borderRadius:10, overflow:'hidden' }}>
      <div style={{ padding:'14px 16px 10px', display:'flex', alignItems:'center', gap:8 }}>
        <Dot color={sc} pulse={inst.tmuxRunning && !inst.kibanaHealth.up} />
        <span style={{ fontWeight:700, fontSize:13, color:'#ddeeff', flex:1 }}>{inst.name}</span>
        {inst.privLocationRunning && <Badge label="priv loc ●" color="#ffd166" bg="rgba(255,209,102,0.12)" border="rgba(255,209,102,0.3)" />}
        <Badge label={inst.type} color={typeColor(inst.type)}
          bg={inst.type==='permanent' ? 'rgba(77,184,255,0.1)' : 'rgba(255,209,102,0.1)'}
          border={inst.type==='permanent' ? 'rgba(77,184,255,0.25)' : 'rgba(255,209,102,0.25)'} />
      </div>
      <div style={{ padding:'0 16px 12px', display:'flex', flexDirection:'column', gap:5 }}>
        <Row k="branch"  v={inst.branch}       vc="#67e8f9" />
        <Row k="kibana"  v={`:${inst.kPort}`}  vc="#3ddc84" />
        <Row k="es"      v={`:${inst.esPort}`} vc="#8fa8c0" />
        <Row k="status"  v={statusLabel(inst)} vc={sc} />
        {inst.kibanaHealth.version && <Row k="version" v={inst.kibanaHealth.version} vc="#8fa8c0" />}
      </div>
      <div style={{ borderTop:'1px solid #1e2836', padding:'10px 16px', display:'flex', flexWrap:'wrap', gap:6 }}>
        {inst.kibanaHealth.up && <ActionBtn label="open" onClick={() => window.open(inst.url, '_blank')} />}
        <ActionBtn label="cursor" onClick={() => api.post(`/instances/${encodeURIComponent(inst.name)}/open`, {})} />
        {!inst.tmuxRunning && <ActionBtn label="start" loading={busy==='start'} onClick={() => act('start', () => api.post(`/instances/${encodeURIComponent(inst.name)}/start`, {}))} />}
        {inst.tmuxRunning && <ActionBtn label="stop" loading={busy==='stop'} onClick={() => act('stop', () => api.post(`/instances/${encodeURIComponent(inst.name)}/stop`, {}))} />}
        {isFeat && <SwitchButton onSwitch={branch => act('switch', () => api.post('/instances/switch', { branch }))} busy={busy==='switch'} />}
        {!isPermanent && <ActionBtn danger label="kill" loading={busy==='kill'} onClick={() => act('kill', () => api.delete(`/instances/${encodeURIComponent(inst.branch)}`))} />}
        {!inst.privLocationRunning
          ? <ActionBtn label="▶ priv location" loading={busy==='privloc-start'} onClick={() => { setShowLogs(true); act('privloc-start', () => api.post(`/instances/${encodeURIComponent(inst.name)}/private-location/start`, {})); }} />
          : <ActionBtn danger label="■ stop priv loc" loading={busy==='privloc-stop'} onClick={() => act('privloc-stop', () => api.post(`/instances/${encodeURIComponent(inst.name)}/private-location/stop`, {}))} />
        }
        <ActionBtn label={showLogs ? 'hide logs' : 'logs'} onClick={() => setShowLogs(l => !l)} />
      </div>
      {log && <pre style={{ margin:'0 16px 8px', padding:'6px 10px', background:'#060810', border:'1px solid #1e2836', borderRadius:6, fontSize:10, color: log.toLowerCase().includes('error') ? '#e87070' : '#4db8ff', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:80, overflowY:'auto' }}>{log}</pre>}
      <LogPanel name={inst.name} visible={showLogs} />
    </div>
  );
}

function NewInstancePanel({ onCreated }) {
  const [open,   setOpen]   = useState(false);
  const [branch, setBranch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [busy,   setBusy]   = useState(false);
  const [log,    setLog]    = useState('');
  const [branches, setBranches] = useState([]);

  useEffect(() => { api.get('/git/branches').then(r => setBranches(r.branches ?? [])); }, []);

  const filtered = (branch && showDropdown) ? branches.filter(b => b.toLowerCase().includes(branch.toLowerCase())).slice(0, 6) : [];

  async function create() {
    if (!branch) return;
    setBusy(true); setLog('');
    try { const res = await api.post('/instances/new', { branch }); setLog(res.output ?? res.error ?? 'launched'); onCreated(); }
    catch (e) { setLog(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ background:'#0f1318', border:'1px solid #1e2836', borderTop:'2px solid #3ddc84', borderRadius:10, padding:'14px 16px' }}>
      <button onClick={() => setOpen(o => !o)} style={{ background:'none', border:'none', cursor:'pointer', color:'#3ddc84', fontFamily:'JetBrains Mono, monospace', fontSize:12, fontWeight:700, padding:0, display:'flex', alignItems:'center', gap:6 }}>
        <span style={{ fontSize:16 }}>{open ? '−' : '+'}</span> new instance
      </button>
      {open && (
        <div style={{ marginTop:12 }}>
          <div style={{ position:'relative' }}>
            <input placeholder="branch name…" value={branch}
              onChange={e => { setBranch(e.target.value); setShowDropdown(true); }}
              onKeyDown={e => { if (e.key === 'Enter') { setShowDropdown(false); create(); } }}
              onBlur={() => setShowDropdown(false)}
              style={{ width:'100%', background:'#060810', border:'1px solid #253040', borderRadius:5, color:'#ddeeff', fontSize:11, padding:'6px 10px', fontFamily:'JetBrains Mono, monospace', outline:'none', boxSizing:'border-box' }}
            />
            {filtered.length > 0 && (
              <div style={{ position:'absolute', top:'105%', left:0, right:0, background:'#0f1318', border:'1px solid #253040', borderRadius:6, zIndex:50 }}>
                {filtered.map(b => (
                  <div key={b} onMouseDown={e => { e.preventDefault(); setBranch(b); setShowDropdown(false); }}
                    style={{ padding:'5px 10px', fontSize:11, color:'#8fa8c0', cursor:'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.background='#151b24'}
                    onMouseLeave={e => e.currentTarget.style.background='none'}
                  >{b}</div>
                ))}
              </div>
            )}
          </div>
          <div style={{ marginTop:10 }}>
            <ActionBtn label={busy ? 'launching…' : 'launch'} loading={busy} onClick={create} disabled={!branch} />
          </div>
          {log && <pre style={{ marginTop:8, padding:'8px 10px', background:'#060810', border:'1px solid #1e2836', borderRadius:6, fontSize:10, color:'#4db8ff', whiteSpace:'pre-wrap', wordBreak:'break-all', maxHeight:80, overflowY:'auto' }}>{log}</pre>}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:18, fontWeight:700, color, lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:9, letterSpacing:'0.1em', textTransform:'uppercase', color:'#3d5060', marginTop:2 }}>{label}</div>
    </div>
  );
}

function StopAllButton({ onDone }) {
  const [busy, setBusy] = useState(false);
  async function stopAll() {
    if (!confirm('Stop all running instances?')) return;
    setBusy(true);
    await api.post('/instances/stop-all', {});
    await onDone();
    setBusy(false);
  }
  return (
    <button onClick={stopAll} disabled={busy} style={{ background:'none', border:'1px solid rgba(232,112,112,0.35)', borderRadius:6, color: busy ? '#3d5060' : '#e87070', padding:'5px 10px', cursor: busy ? 'not-allowed' : 'pointer', fontSize:11, fontFamily:'JetBrains Mono, monospace', opacity: busy ? 0.5 : 1 }}>
      {busy ? 'stopping…' : '⏹ stop all'}
    </button>
  );
}

export default function App() {
  const [instances,    setInstances]    = useState([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState(null);
  const [lastPoll,     setLastPoll]     = useState(null);
  const load = useCallback(async () => {
    try { const data = await api.get('/instances'); setInstances(data.instances ?? []); setError(null); }
    catch { setError('Cannot reach server on :3001 — is the server running?'); }
    finally { setLoading(false); setLastPoll(new Date()); }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 8000); return () => clearInterval(iv); }, [load]);

  const running = instances.filter(i => i.tmuxRunning).length;
  const healthy = instances.filter(i => i.kibanaHealth.up).length;

  return (
    <div style={{ minHeight:'100vh', background:'#080b10', fontFamily:'JetBrains Mono, monospace', color:'#8fa8c0' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Syne:wght@700;800&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:#253040; border-radius:4px; }
      `}</style>
      <div style={{ borderBottom:'1px solid #1e2836', padding:'14px 28px', display:'flex', alignItems:'center', gap:16 }}>
        <div>
          <div style={{ fontSize:10, letterSpacing:'0.2em', textTransform:'uppercase', color:'#3d5060' }}>kibana observability</div>
          <div style={{ fontFamily:'Syne, sans-serif', fontWeight:800, fontSize:18, color:'#ddeeff', letterSpacing:'-0.02em' }}>Instance Manager</div>
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:20, fontSize:11 }}>
          <Stat label="sessions" value={running} color="#3ddc84" />
          <Stat label="healthy"  value={healthy} color="#3ddc84" />
          <Stat label="total"    value={instances.length} color="#4db8ff" />
        </div>
        <button onClick={load} style={{ background:'none', border:'1px solid #1e2836', borderRadius:6, color:'#3d5060', padding:'5px 10px', cursor:'pointer', fontSize:11, fontFamily:'JetBrains Mono, monospace' }}
          onMouseEnter={e => e.target.style.color='#8fa8c0'} onMouseLeave={e => e.target.style.color='#3d5060'}>↻ refresh</button>
        {running > 0 && <StopAllButton onDone={load} />}
      </div>
      <div style={{ padding:'24px 28px', maxWidth:1400 }}>
        {loading && <div style={{ color:'#3d5060', fontSize:12 }}>loading…</div>}
        {error   && <div style={{ background:'rgba(255,107,107,0.08)', border:'1px solid rgba(255,107,107,0.25)', borderRadius:8, padding:'12px 16px', color:'#e87070', fontSize:12, marginBottom:20 }}>{error}</div>}
        {!loading && !error && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            {instances.map(inst => <InstanceCard key={inst.name} inst={inst} onRefresh={load} />)}
            <NewInstancePanel onCreated={load} />
          </div>
        )}
        {lastPoll && <div style={{ marginTop:20, fontSize:10, color:'#1e2836', textAlign:'right' }}>last polled {lastPoll.toLocaleTimeString()} · auto-refreshes every 8s</div>}
      </div>
    </div>
  );
}

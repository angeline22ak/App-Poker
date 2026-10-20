/* Mesa Poker — app principal */
(function () {
  const C = window.POKER_CONFIG;
  const supa = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY);
  const $app = document.getElementById('app');

  // ---------- estado ----------
  const S = {
    view: 'home',
    role: localStorage.getItem('pk_role'),
    adminPin: sessionStorage.getItem('pk_admin_pin'),
    playerId: localStorage.getItem('pk_player_id'),
    playerName: localStorage.getItem('pk_player_name'),
    sessionId: localStorage.getItem('pk_session_id'),
    sessions: [], players: [], tx: [], rakes: [], rules: [], awards: [],
    adminTab: 'mesa',
    chipCounts: {}, pot: 0,
    rt: false, timer: null,
  };

  // ---------- utilidades ----------
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmt = (v) => brl.format(Number(v) || 0);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const whenFull = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const num = (s) => { const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.')); return isNaN(n) ? 0 : n; };

  let toastT;
  function toast(msg, err) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.toggle('err', !!err); el.classList.remove('hidden');
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  async function rpc(name, args) {
    const { data, error } = await supa.rpc(name, args);
    if (error) throw new Error(error.message || 'Erro de conexão');
    return data;
  }

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------- dados ----------
  async function loadAll() {
    const [se, pl, br, ba] = await Promise.all([
      supa.from('poker_sessions').select('*').order('created_at', { ascending: false }).limit(100),
      supa.from('poker_players').select('id,name,created_at').order('name'),
      supa.from('poker_bonus_rules').select('*').order('type'),
      supa.from('poker_bonus_awards').select('*').eq('voided', false).order('earned_at', { ascending: false }).limit(500),
    ]);
    S.sessions = se.data || []; S.players = pl.data || [];
    S.rules = br.data || []; S.awards = ba.data || [];
    if (!S.sessions.find(x => x.id === S.sessionId)) S.sessionId = null;
    if (!S.sessionId) {
      const open = S.sessions.find(x => x.status === 'open');
      S.sessionId = (open || S.sessions[0] || {}).id || null;
      if (S.sessionId) localStorage.setItem('pk_session_id', S.sessionId);
    }
    await loadSessionData();
  }

  async function loadSessionData() {
    if (!S.sessionId) { S.tx = []; S.rakes = []; return; }
    const [t, r] = await Promise.all([
      supa.from('poker_transactions').select('*').eq('session_id', S.sessionId).eq('voided', false).order('created_at', { ascending: false }).limit(500),
      supa.from('poker_rake_entries').select('*').eq('session_id', S.sessionId).eq('voided', false).order('created_at', { ascending: false }).limit(1000),
    ]);
    S.tx = t.data || []; S.rakes = r.data || [];
  }

  const refresh = debounce(async () => { try { await loadAll(); render(); } catch (e) { /* offline */ } }, 350);

  function startRealtime() {
    supa.channel('poker-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_transactions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_rake_entries' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_sessions' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_bonus_rules' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'poker_bonus_awards' }, refresh)
      .subscribe((st) => {
        S.rt = st === 'SUBSCRIBED';
        const dot = document.getElementById('live-dot');
        dot.classList.toggle('on', S.rt);
        dot.textContent = S.rt ? '● ao vivo' : '○ conectando…';
      });
  }

  // ---------- estatísticas ----------
  function cur() { return S.sessions.find(x => x.id === S.sessionId) || null; }

  function stats() {
    const c = cur();
    const sum = (arr) => arr.reduce((a, t) => a + Number(t.amount), 0);
    const buy = sum(S.tx.filter(t => t.type === 'buy_in' || t.type === 'rebuy'));
    const out = sum(S.tx.filter(t => t.type === 'cash_out'));
    const rakeTotal = S.rakes.reduce((a, r) => a + Number(r.rake_amount), 0);
    const hands = S.rakes.length;
    const withPot = S.rakes.filter(r => Number(r.pot_amount) > 0);
    const avgPct = withPot.length ? withPot.reduce((a, r) => a + Number(r.rake_amount) / Number(r.pot_amount), 0) / withPot.length * 100 : null;
    let rakeHr = 0;
    if (c) {
      const end = c.closed_at ? new Date(c.closed_at) : new Date();
      const h = Math.max((end - new Date(c.created_at)) / 36e5, 1 / 60);
      rakeHr = rakeTotal / h;
    }
    return { c, buy, out, onTable: buy - out - rakeTotal, rakeTotal, hands, avgRake: hands ? rakeTotal / hands : 0, avgPct, rakeHr, potCount: withPot.length };
  }

  function playerStats(pid) {
    const mine = S.tx.filter(t => t.player_id === pid);
    const sum = (arr) => arr.reduce((a, t) => a + Number(t.amount), 0);
    const buy = sum(mine.filter(t => t.type === 'buy_in' || t.type === 'rebuy'));
    const out = sum(mine.filter(t => t.type === 'cash_out'));
    return { mine, buy, out, result: out - buy };
  }

  // ---------- componentes ----------
  function tiles(list) {
    return '<div class="tiles">' + list.map(t =>
      `<div class="tile ${t.hero ? 'hero' : ''}"><div class="t-label">${t.label}</div><div class="t-value">${t.value}</div>${t.note ? `<div class="t-note">${t.note}</div>` : ''}</div>`
    ).join('') + '</div>';
  }

  function sessionPicker() {
    if (!S.sessions.length) return '';
    return `<select id="sess-pick">${S.sessions.map(s =>
      `<option value="${s.id}" ${s.id === S.sessionId ? 'selected' : ''}>${esc(s.name)} · ${s.status === 'open' ? 'aberta' : 'fechada'} · ${whenFull(s.created_at)}</option>`).join('')}</select>`;
  }

  function bindSessionPicker() {
    const el = document.getElementById('sess-pick');
    if (el) el.onchange = async () => {
      S.sessionId = el.value; localStorage.setItem('pk_session_id', el.value);
      await loadSessionData(); render();
    };
  }

  function liveTiles(st) {
    return tiles([
      { label: 'RAKE TOTAL DA MESA', value: fmt(st.rakeTotal), note: st.c ? `desde ${whenFull(st.c.created_at)}` : '', hero: true },
      { label: 'MÃOS CONTADAS', value: st.hands },
      { label: 'RAKE MÉDIO / MÃO', value: fmt(st.avgRake) },
      { label: '% MÉDIA DA CASA', value: st.avgPct == null ? '—' : st.avgPct.toFixed(1) + '%', note: st.avgPct == null ? 'informe o pote nas mãos' : `${st.potCount} mão(s) com pote` },
      { label: 'RAKE / HORA', value: fmt(st.rakeHr) },
      { label: 'DINHEIRO NA MESA', value: fmt(st.onTable), note: 'compras − saques − rake' },
      { label: 'ENTROU EM JOGO', value: fmt(st.buy) },
    ]);
  }

  // ---------- views ----------
  function render() {
    document.getElementById('btn-logout').classList.toggle('hidden', !S.role);
    const v = S.view;
    if (v === 'home') return renderHome();
    if (v === 'adminLogin') return renderAdminLogin();
    if (v === 'playerLogin') return renderPlayerLogin();
    if (v === 'admin') return renderAdmin();
    if (v === 'player') return renderPlayer();
    if (v === 'live') return renderLive();
  }

  function go(view) { S.view = view; render(); window.scrollTo(0, 0); }

  function renderHome() {
    $app.innerHTML = `
      <div class="home-hero">
        <div class="logo">
          <svg width="72" height="72" viewBox="0 0 48 48"><circle cx="24" cy="24" r="21" fill="none" stroke="#e8c15a" stroke-width="5" stroke-dasharray="11 7"/><circle cx="24" cy="24" r="12" fill="#e8c15a"/><text x="24" y="29" text-anchor="middle" font-size="14" font-weight="700" fill="#0b1512">♠</text></svg>
        </div>
        <h1>Mesa Poker</h1>
        <p class="sub">Controle financeiro da mesa: buy-in, rebuy, cash-out e rake — em tempo real.</p>
      </div>
      <div class="home-actions">
        <button class="btn btn-primary btn-block" id="go-live">📺 Ver a mesa ao vivo</button>
        <button class="btn btn-felt btn-block" id="go-player">🙋 Sou jogador — minha conta</button>
        <button class="btn btn-block" id="go-admin">🔑 Sou admin da mesa</button>
        <button class="btn btn-ghost btn-block" id="go-install">📲 Instalar na tela inicial</button>
      </div>
      <p class="footnote">MVP de teste · os dados são atualizados ao vivo em todos os aparelhos</p>`;
    document.getElementById('go-live').onclick = () => go('live');
    document.getElementById('go-admin').onclick = () => S.role === 'admin' && S.adminPin ? go('admin') : go('adminLogin');
    document.getElementById('go-player').onclick = () => S.role === 'player' && S.playerId ? go('player') : go('playerLogin');
    document.getElementById('go-install').onclick = tryInstall;
  }

  function renderAdminLogin() {
    $app.innerHTML = `
      <h1>Entrar como admin</h1>
      <p class="sub">Digite o PIN do administrador da mesa.</p>
      <div class="card">
        <label>PIN do admin</label>
        <input id="in-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••••">
        <button class="btn btn-primary btn-block" id="do-login">Entrar</button>
      </div>`;
    const doIt = async () => {
      const pin = document.getElementById('in-pin').value.trim();
      try {
        const ok = await rpc('poker_admin_check', { p_pin: pin });
        if (!ok) return toast('PIN incorreto', true);
        S.role = 'admin'; S.adminPin = pin;
        localStorage.setItem('pk_role', 'admin'); sessionStorage.setItem('pk_admin_pin', pin);
        go('admin');
      } catch (e) { toast(e.message, true); }
    };
    document.getElementById('do-login').onclick = doIt;
    document.getElementById('in-pin').addEventListener('keydown', e => e.key === 'Enter' && doIt());
  }

  function renderPlayerLogin() {
    $app.innerHTML = `
      <h1>Minha conta</h1>
      <p class="sub">Escolha seu nome e digite seu PIN (peça ao admin se ainda não tem).</p>
      <div class="card">
        <label>Jogador</label>
        <select id="in-name">${S.players.map(p => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('') || '<option value="">(nenhum jogador cadastrado)</option>'}</select>
        <label>PIN</label>
        <input id="in-ppin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••">
        <button class="btn btn-felt btn-block" id="do-plogin">Entrar</button>
      </div>`;
    const doIt = async () => {
      const name = document.getElementById('in-name').value;
      const pin = document.getElementById('in-ppin').value.trim();
      try {
        const id = await rpc('poker_player_login', { p_name: name, p_pin: pin });
        S.role = 'player'; S.playerId = id; S.playerName = name;
        localStorage.setItem('pk_role', 'player');
        localStorage.setItem('pk_player_id', id);
        localStorage.setItem('pk_player_name', name);
        go('player');
      } catch (e) { toast(e.message, true); }
    };
    document.getElementById('do-plogin').onclick = doIt;
    document.getElementById('in-ppin').addEventListener('keydown', e => e.key === 'Enter' && doIt());
  }

  // ---------- ADMIN ----------
  function renderAdmin() {
    if (!S.adminPin) return go('adminLogin');
    const st = stats();
    const tabs = [['mesa', 'Mesa'], ['caixa', 'Caixa'], ['jog', 'Jogadores'], ['bonus', 'Bônus'], ['cfg', 'Config']];
    $app.innerHTML = `
      <h1>Painel do admin</h1>
      ${sessionPicker()}
      <div class="seg">${tabs.map(([k, l]) => `<button data-t="${k}" class="${S.adminTab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="tab-body"></div>`;
    bindSessionPicker();
    document.querySelectorAll('.seg button').forEach(b => b.onclick = () => { S.adminTab = b.dataset.t; render(); });
    const body = document.getElementById('tab-body');
    if (S.adminTab === 'mesa') renderTabMesa(body, st);
    else if (S.adminTab === 'caixa') renderTabCaixa(body, st);
    else if (S.adminTab === 'jog') renderTabJog(body, st);
    else if (S.adminTab === 'bonus') renderTabBonus(body, st);
    else renderTabCfg(body, st);
  }

  function renderTabMesa(el, st) {
    const c = st.c;
    if (!c) {
      el.innerHTML = `<div class="card"><p class="sub">Nenhuma mesa criada ainda.</p>
        <label>Nome da mesa</label><input id="new-sess" placeholder="Mesa de sexta">
        <button class="btn btn-primary btn-block" id="mk-sess">Abrir mesa</button></div>`;
      document.getElementById('mk-sess').onclick = createSession;
      return;
    }
    const chips = c.chip_values || [];
    const total = chips.reduce((a, ch) => a + (S.chipCounts[ch.color] || 0) * Number(ch.value), 0);
    const pctNow = S.pot > 0 ? (total / S.pot * 100).toFixed(1) + '%' : null;
    el.innerHTML = `
      ${liveTiles(st)}
      ${c.status === 'open' ? `
      <div class="card">
        <h3>🪙 Registrar rake da mão</h3>
        <p class="sub">Toque nas fichas que a casa recolheu nesta mão.</p>
        <div class="chip-pad">
          ${chips.map(ch => `
            <div class="chip-row">
              <span class="chip-dot" style="background:${esc(ch.hex)}"></span>
              <span class="chip-name">${esc(ch.color)}<small>${fmt(ch.value)}</small></span>
              <button class="chip-btn" data-c="${esc(ch.color)}" data-d="-1">−</button>
              <span class="chip-count">${S.chipCounts[ch.color] || 0}</span>
              <button class="chip-btn" data-c="${esc(ch.color)}" data-d="1">+</button>
            </div>`).join('')}
        </div>
        <div class="pad-total"><span>Rake da mão ${pctNow ? `(${pctNow} do pote)` : ''}</span><span class="v">${fmt(total)}</span></div>
        <label>Pote estimado (opcional — melhora a % da casa)</label>
        <div class="quick">
          ${[50, 100, 200, 300, 500].map(v => `<button class="btn btn-sm" data-pot="${v}">+${v}</button>`).join('')}
          <button class="btn btn-sm" data-pot="0">zerar</button>
        </div>
        <input id="pot-in" inputmode="decimal" placeholder="Pote em R$ (opcional)" value="${S.pot || ''}">
        <div class="btn-row">
          <button class="btn btn-ghost" id="pad-clear">Limpar</button>
          <button class="btn btn-primary" id="pad-save">Registrar mão</button>
        </div>
      </div>` : '<div class="card"><p class="sub">Mesa fechada — somente consulta.</p></div>'}
      <div class="card">
        <h3>Últimas mãos</h3>
        <div class="list">${S.rakes.slice(0, 12).map(r => `
          <div class="row">
            <div class="grow">${fmt(r.rake_amount)} ${r.pot_amount ? `<span class="badge">${(r.rake_amount / r.pot_amount * 100).toFixed(1)}% de ${fmt(r.pot_amount)}</span>` : ''}
              <div class="when">${when(r.created_at)}</div></div>
            <button class="x-btn" data-del-rake="${r.id}">✕</button>
          </div>`).join('') || '<p class="sub">Nenhuma mão registrada.</p>'}</div>
      </div>`;
    el.querySelectorAll('.chip-btn').forEach(b => b.onclick = () => {
      const k = b.dataset.c; S.chipCounts[k] = Math.max(0, (S.chipCounts[k] || 0) + Number(b.dataset.d)); render();
    });
    el.querySelectorAll('[data-pot]').forEach(b => b.onclick = () => {
      const v = Number(b.dataset.pot); S.pot = v === 0 ? 0 : (S.pot || 0) + v; render();
    });
    const potIn = document.getElementById('pot-in');
    if (potIn) potIn.onchange = () => { S.pot = num(potIn.value); };
    const clear = document.getElementById('pad-clear');
    if (clear) clear.onclick = () => { S.chipCounts = {}; S.pot = 0; render(); };
    const save = document.getElementById('pad-save');
    if (save) save.onclick = async () => {
      const chipsObj = {}; chips.forEach(ch => { if (S.chipCounts[ch.color]) chipsObj[ch.color] = S.chipCounts[ch.color]; });
      const amount = chips.reduce((a, ch) => a + (S.chipCounts[ch.color] || 0) * Number(ch.value), 0);
      if (amount <= 0) return toast('Marque pelo menos uma ficha', true);
      if (potIn) S.pot = num(potIn.value);
      try {
        await rpc('poker_add_rake', { p_admin_pin: S.adminPin, p_session_id: c.id, p_chips: chipsObj, p_rake_amount: amount, p_pot_amount: S.pot > 0 ? S.pot : null });
        S.chipCounts = {}; S.pot = 0;
        toast('Mão registrada: ' + fmt(amount));
        await loadSessionData(); render();
      } catch (e) { toast(e.message, true); }
    };
    el.querySelectorAll('[data-del-rake]').forEach(b => b.onclick = async () => {
      if (!confirm('Estornar esta mão?')) return;
      try { await rpc('poker_void_rake', { p_admin_pin: S.adminPin, p_id: b.dataset.delRake }); await loadSessionData(); render(); }
      catch (e) { toast(e.message, true); }
    });
  }

  let caixaType = 'buy_in';
  function renderTabCaixa(el, st) {
    const c = st.c;
    el.innerHTML = `
      ${c && c.status === 'open' ? `
      <div class="card">
        <h3>💸 Lançar movimento</h3>
        <label>Jogador</label>
        <select id="tx-player">${S.players.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('') || '<option value="">(cadastre jogadores na aba Jogadores)</option>'}</select>
        <div class="seg">
          <button data-ty="buy_in" class="${caixaType === 'buy_in' ? 'on' : ''}">Buy-in</button>
          <button data-ty="rebuy" class="${caixaType === 'rebuy' ? 'on' : ''}">Rebuy</button>
          <button data-ty="cash_out" class="${caixaType === 'cash_out' ? 'on' : ''}">Cash-out</button>
        </div>
        <div class="quick">${[50, 100, 200, 500].map(v => `<button class="btn btn-sm" data-q="${v}">R$ ${v}</button>`).join('')}</div>
        <input id="tx-amount" inputmode="decimal" placeholder="Valor em R$">
        <button class="btn btn-primary btn-block" id="tx-save">Registrar</button>
      </div>` : '<div class="card"><p class="sub">Mesa fechada ou inexistente.</p></div>'}
      <div class="card">
        <h3>Movimentos da mesa</h3>
        <div class="list">${S.tx.slice(0, 30).map(t => {
          const p = S.players.find(x => x.id === t.player_id);
          const isOut = t.type === 'cash_out';
          const label = { buy_in: 'Buy-in', rebuy: 'Rebuy', cash_out: 'Cash-out', adjust: 'Ajuste' }[t.type];
          return `<div class="row">
            <div class="grow"><strong>${esc(p ? p.name : '?')}</strong> <span class="badge">${label}</span>
            <div class="when">${whenFull(t.created_at)}</div></div>
            <span class="amount ${isOut ? 'out' : 'in'}">${isOut ? '−' : '+'}${fmt(t.amount)}</span>
            <button class="x-btn" data-del-tx="${t.id}">✕</button>
          </div>`;
        }).join('') || '<p class="sub">Nenhum movimento ainda.</p>'}</div>
      </div>`;
    el.querySelectorAll('[data-ty]').forEach(b => b.onclick = () => { caixaType = b.dataset.ty; render(); });
    el.querySelectorAll('[data-q]').forEach(b => b.onclick = () => { document.getElementById('tx-amount').value = b.dataset.q; });
    const save = document.getElementById('tx-save');
    if (save) save.onclick = async () => {
      const pid = document.getElementById('tx-player').value;
      const amount = num(document.getElementById('tx-amount').value);
      if (!pid) return toast('Cadastre um jogador primeiro', true);
      if (amount <= 0) return toast('Informe o valor', true);
      try {
        await rpc('poker_add_transaction', { p_admin_pin: S.adminPin, p_session_id: c.id, p_player_id: pid, p_type: caixaType, p_amount: amount });
        toast('Registrado: ' + fmt(amount));
        await loadSessionData(); render();
      } catch (e) { toast(e.message, true); }
    };
    el.querySelectorAll('[data-del-tx]').forEach(b => b.onclick = async () => {
      if (!confirm('Estornar este movimento?')) return;
      try { await rpc('poker_void_tx', { p_admin_pin: S.adminPin, p_id: b.dataset.delTx }); await loadSessionData(); render(); }
      catch (e) { toast(e.message, true); }
    });
  }

  function renderTabJog(el) {
    el.innerHTML = `
      <div class="card">
        <h3>➕ Novo jogador</h3>
        <label>Nome</label><input id="pl-name" placeholder="Nome do jogador">
        <label>PIN (4 a 8 dígitos — o jogador usa para ver a conta)</label>
        <input id="pl-pin" inputmode="numeric" placeholder="ex.: 1234">
        <button class="btn btn-felt btn-block" id="pl-save">Cadastrar</button>
      </div>
      <div class="card">
        <h3>Jogadores e saldos (mesa atual)</h3>
        <div class="table-wrap"><table class="mini">
          <tr><th>Jogador</th><th>Comprou</th><th>Sacou</th><th>Resultado</th></tr>
          ${S.players.map(p => {
            const ps = playerStats(p.id);
            if (!ps.buy && !ps.out) return `<tr><td>${esc(p.name)}</td><td>—</td><td>—</td><td>—</td></tr>`;
            return `<tr><td>${esc(p.name)}</td><td>${fmt(ps.buy)}</td><td>${fmt(ps.out)}</td>
              <td class="amount ${ps.result >= 0 ? 'in' : 'out'}">${fmt(ps.result)}</td></tr>`;
          }).join('')}
        </table></div>
      </div>`;
    document.getElementById('pl-save').onclick = async () => {
      const name = document.getElementById('pl-name').value.trim();
      const pin = document.getElementById('pl-pin').value.trim();
      try {
        await rpc('poker_create_player', { p_admin_pin: S.adminPin, p_name: name, p_player_pin: pin });
        toast('Jogador cadastrado: ' + name);
        await loadAll(); render();
      } catch (e) { toast(e.message, true); }
    };
  }

  // ---------- BÔNUS ----------
  const BONUS_ICON = { gasolina: '⛽', comida: '🍔' };
  const bIcon = (t) => BONUS_ICON[t] || '🎁';
  const hhmm = (min) => `${Math.floor(min / 60)}h${String(Math.round(min) % 60).padStart(2, '0')}`;

  function bonusStatus(a) {
    if (a.redeemed_at) return { label: 'usado', cls: '' };
    if (a.expires_at && new Date(a.expires_at) < new Date()) return { label: 'vencido', cls: 'bad' };
    return { label: 'ativo', cls: 'open' };
  }

  // minutos de mesa do jogador na sessão atual (1º lançamento → fechamento/agora)
  function minutesAtTable(pid) {
    const mine = S.tx.filter(t => t.player_id === pid);
    if (!mine.length) return 0;
    const first = Math.min(...mine.map(t => +new Date(t.created_at)));
    const c = cur();
    const end = c && c.closed_at ? +new Date(c.closed_at) : Date.now();
    return Math.max(0, (end - first) / 60000);
  }

  function renderTabBonus(el) {
    const c = cur();
    const rules = S.rules;
    const inSession = S.players.filter(p => S.tx.some(t => t.player_id === p.id));
    const hasAward = (pid, type) => S.awards.some(a => a.player_id === pid && a.type === type && a.session_id === S.sessionId);
    el.innerHTML = `
      <div class="card">
        <h3>🎁 Regras dos bônus</h3>
        <p class="sub">O jogador ganha ao completar o tempo mínimo de mesa. A validade conta a partir do dia em que ganhou.</p>
        ${rules.map(r => `
        <div class="bonus-rule" data-type="${esc(r.type)}">
          <h3>${bIcon(r.type)} ${esc(r.label)}</h3>
          <div class="rule-grid">
            <div><label>Valor (R$)</label><input class="br-amount" inputmode="decimal" value="${r.amount}"></div>
            <div><label>Tempo mín. (min)</label><input class="br-min" inputmode="numeric" value="${r.min_minutes}"></div>
            <div><label>Validade (dias)</label><input class="br-days" inputmode="numeric" value="${r.valid_days}"></div>
          </div>
          <div class="btn-row">
            <label class="chk"><input type="checkbox" class="br-active" ${r.active ? 'checked' : ''}> ativo</label>
            <button class="btn btn-sm br-save">Salvar</button>
          </div>
        </div>`).join('') || '<p class="sub">Nenhuma regra cadastrada.</p>'}
      </div>
      <div class="card">
        <h3>⏱️ Quem já pode ganhar (mesa atual)</h3>
        <div class="list">${!c ? '<p class="sub">Nenhuma mesa selecionada.</p>' : inSession.map(p => {
          const min = minutesAtTable(p.id);
          return `<div class="row"><div class="grow"><strong>${esc(p.name)}</strong>
            <div class="when">${hhmm(min)} de mesa</div></div>
            <div class="bonus-actions">${rules.filter(r => r.active).map(r => {
              if (hasAward(p.id, r.type)) return `<span class="badge">${bIcon(r.type)} dado</span>`;
              if (min >= r.min_minutes) return `<button class="btn btn-sm btn-primary" data-award="${p.id}" data-bt="${esc(r.type)}">${bIcon(r.type)} dar ${fmt(r.amount)}</button>`;
              return `<span class="badge">${bIcon(r.type)} falta ${hhmm(r.min_minutes - min)}</span>`;
            }).join(' ')}</div>
          </div>`;
        }).join('') || '<p class="sub">Nenhum jogador com movimento nesta mesa.</p>'}</div>
      </div>
      <div class="card">
        <h3>Bônus concedidos</h3>
        <div class="list">${S.awards.map(a => {
          const p = S.players.find(x => x.id === a.player_id);
          const stt = bonusStatus(a);
          return `<div class="row">
            <div class="grow"><strong>${esc(p ? p.name : '?')}</strong> ${bIcon(a.type)} ${fmt(a.amount)}
              <span class="badge ${stt.cls}">${stt.label}</span>
              <div class="when">${whenFull(a.earned_at)}${a.expires_at ? ' · vale até ' + whenFull(a.expires_at) : ''}</div></div>
            ${!a.redeemed_at ? `<button class="btn btn-sm" data-redeem="${a.id}">usar</button>` : ''}
            <button class="btn btn-sm" data-expiry="${a.id}">✎</button>
            <button class="x-btn" data-void-bonus="${a.id}">✕</button>
          </div>`;
        }).join('') || '<p class="sub">Nenhum bônus concedido ainda.</p>'}</div>
      </div>`;
    el.querySelectorAll('.bonus-rule .br-save').forEach(btn => btn.onclick = async () => {
      const box = btn.closest('.bonus-rule');
      try {
        await rpc('poker_update_bonus_rule', {
          p_admin_pin: S.adminPin, p_type: box.dataset.type,
          p_amount: num(box.querySelector('.br-amount').value) || null,
          p_min_minutes: parseInt(box.querySelector('.br-min').value, 10) || null,
          p_valid_days: parseInt(box.querySelector('.br-days').value, 10) || null,
          p_active: box.querySelector('.br-active').checked,
        });
        toast('Regra salva'); await loadAll(); render();
      } catch (e) { toast(e.message, true); }
    });
    el.querySelectorAll('[data-award]').forEach(b => b.onclick = async () => {
      const r = S.rules.find(x => x.type === b.dataset.bt);
      const exp = new Date(Date.now() + (r ? r.valid_days : 7) * 864e5).toISOString();
      try {
        await rpc('poker_award_bonus', { p_admin_pin: S.adminPin, p_player_id: b.dataset.award, p_session_id: S.sessionId, p_type: b.dataset.bt, p_amount: null, p_expires_at: exp });
        toast('Bônus concedido 🎁'); await loadAll(); render();
      } catch (e) { toast(e.message, true); }
    });
    el.querySelectorAll('[data-redeem]').forEach(b => b.onclick = async () => {
      if (!confirm('Marcar este bônus como usado?')) return;
      try { await rpc('poker_redeem_bonus', { p_admin_pin: S.adminPin, p_id: b.dataset.redeem }); toast('Bônus usado'); await loadAll(); render(); }
      catch (e) { toast(e.message, true); }
    });
    el.querySelectorAll('[data-expiry]').forEach(b => b.onclick = async () => {
      const d = prompt('Validade: quantos dias a partir de hoje? (vazio = sem prazo)');
      if (d === null) return;
      const exp = d.trim() === '' ? null : new Date(Date.now() + num(d) * 864e5).toISOString();
      try { await rpc('poker_set_bonus_expiry', { p_admin_pin: S.adminPin, p_id: b.dataset.expiry, p_expires_at: exp }); toast('Prazo atualizado'); await loadAll(); render(); }
      catch (e) { toast(e.message, true); }
    });
    el.querySelectorAll('[data-void-bonus]').forEach(b => b.onclick = async () => {
      if (!confirm('Cancelar este bônus?')) return;
      try { await rpc('poker_void_bonus', { p_admin_pin: S.adminPin, p_id: b.dataset.voidBonus }); await loadAll(); render(); }
      catch (e) { toast(e.message, true); }
    });
  }

  function renderTabCfg(el, st) {
    const c = st.c;
    const chips = c ? (c.chip_values || []) : [];
    el.innerHTML = `
      <div class="card">
        <h3>🆕 Nova mesa</h3>
        <label>Nome</label><input id="new-sess" placeholder="Mesa de sexta">
        <button class="btn btn-primary btn-block" id="mk-sess">Abrir nova mesa</button>
      </div>
      ${c ? `
      <div class="card">
        <h3>⚙️ Mesa atual: ${esc(c.name)}</h3>
        <label>Rake da casa (%)</label>
        <input id="cfg-rake" inputmode="decimal" value="${c.rake_percent}">
        <label>Teto do rake por mão (R$ — vazio = sem teto)</label>
        <input id="cfg-cap" inputmode="decimal" value="${c.rake_cap ?? ''}">
        <h3 style="margin-top:14px">Fichas (cor e valor)</h3>
        <div id="chip-editor">${chips.map((ch, i) => `
          <div class="chip-row" data-i="${i}">
            <input type="color" value="${esc(ch.hex)}" style="width:44px;height:38px;padding:2px;margin:0" class="ce-hex">
            <input class="ce-name" value="${esc(ch.color)}" style="margin:0" placeholder="Nome">
            <input class="ce-val" value="${ch.value}" inputmode="decimal" style="margin:0;max-width:84px" placeholder="R$">
            <button class="x-btn ce-del">✕</button>
          </div>`).join('')}
        </div>
        <button class="btn btn-sm" id="chip-add">+ ficha</button>
        <div class="btn-row" style="margin-top:12px">
          <button class="btn btn-primary" id="cfg-save">Salvar configurações</button>
        </div>
        ${c.status === 'open' ? '<button class="btn btn-danger btn-block" id="cfg-close" style="margin-top:10px">🔒 Fechar mesa</button>' : ''}
      </div>` : ''}
      <div class="card">
        <h3>📱 QR Code da mesa</h3>
        <p class="sub">Imprima e deixe na mesa — o jogador escaneia e cai direto no app.</p>
        <button class="btn btn-block" id="open-qr">Abrir página do QR (imprimir)</button>
      </div>
      <div class="card">
        <h3>🔑 Trocar PIN do admin</h3>
        <label>Novo PIN (4 a 8 dígitos)</label>
        <input id="new-pin" inputmode="numeric" placeholder="novo PIN">
        <button class="btn btn-block" id="pin-save">Trocar PIN</button>
      </div>`;
    document.getElementById('mk-sess').onclick = createSession;
    document.getElementById('open-qr').onclick = () => window.open('qr.html', '_blank');
    const addBtn = document.getElementById('chip-add');
    if (addBtn) addBtn.onclick = () => {
      const ed = document.getElementById('chip-editor');
      const div = document.createElement('div'); div.className = 'chip-row';
      div.innerHTML = `<input type="color" value="#888888" style="width:44px;height:38px;padding:2px;margin:0" class="ce-hex">
        <input class="ce-name" value="" style="margin:0" placeholder="Nome">
        <input class="ce-val" value="" inputmode="decimal" style="margin:0;max-width:84px" placeholder="R$">
        <button class="x-btn ce-del">✕</button>`;
      ed.appendChild(div);
      div.querySelector('.ce-del').onclick = () => div.remove();
    };
    el.querySelectorAll('.ce-del').forEach(b => b.onclick = () => b.closest('.chip-row').remove());
    const cfgSave = document.getElementById('cfg-save');
    if (cfgSave) cfgSave.onclick = async () => {
      const rows = [...document.querySelectorAll('#chip-editor .chip-row')];
      const chipVals = rows.map(r => ({
        color: r.querySelector('.ce-name').value.trim() || 'Ficha',
        hex: r.querySelector('.ce-hex').value,
        value: num(r.querySelector('.ce-val').value),
      })).filter(x => x.value > 0);
      const rk = num(document.getElementById('cfg-rake').value);
      const capRaw = document.getElementById('cfg-cap').value.trim();
      try {
        await rpc('poker_update_session', {
          p_admin_pin: S.adminPin, p_session_id: c.id,
          p_rake_percent: rk > 0 ? rk : null,
          p_rake_cap: capRaw === '' ? null : num(capRaw),
          p_chip_values: chipVals.length ? chipVals : null,
        });
        toast('Configurações salvas');
        await loadAll(); render();
      } catch (e) { toast(e.message, true); }
    };
    const closeBtn = document.getElementById('cfg-close');
    if (closeBtn) closeBtn.onclick = async () => {
      if (!confirm('Fechar a mesa? Os lançamentos ficam só para consulta.')) return;
      try { await rpc('poker_close_session', { p_admin_pin: S.adminPin, p_session_id: c.id }); toast('Mesa fechada'); await loadAll(); render(); }
      catch (e) { toast(e.message, true); }
    };
    document.getElementById('pin-save').onclick = async () => {
      const np = document.getElementById('new-pin').value.trim();
      try {
        await rpc('poker_change_admin_pin', { p_old: S.adminPin, p_new: np });
        S.adminPin = np; sessionStorage.setItem('pk_admin_pin', np);
        toast('PIN alterado');
      } catch (e) { toast(e.message, true); }
    };
  }

  async function createSession() {
    const name = (document.getElementById('new-sess') || {}).value || '';
    try {
      const id = await rpc('poker_create_session', { p_admin_pin: S.adminPin, p_name: name, p_rake_percent: null, p_rake_cap: null, p_chip_values: null });
      S.sessionId = id; localStorage.setItem('pk_session_id', id);
      toast('Mesa aberta!');
      await loadAll(); render();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- JOGADOR ----------
  function renderPlayer() {
    if (!S.playerId) return go('playerLogin');
    const st = stats();
    const ps = playerStats(S.playerId);
    const open = st.c && st.c.status === 'open';
    $app.innerHTML = `
      <h1>Olá, ${esc(S.playerName)} 👋</h1>
      ${sessionPicker()}
      ${tiles([
        { label: open ? 'VOCÊ COLOCOU NA MESA' : 'RESULTADO DA SESSÃO', value: open ? fmt(ps.buy) : fmt(ps.result), hero: true, note: open ? 'buy-in + rebuys' : 'saques − compras' },
        { label: 'COMPROU', value: fmt(ps.buy) },
        { label: 'SACOU', value: fmt(ps.out) },
      ])}
      <div class="card">
        <h3>Meu extrato</h3>
        <div class="list">${ps.mine.map(t => {
          const isOut = t.type === 'cash_out';
          const label = { buy_in: 'Buy-in', rebuy: 'Rebuy', cash_out: 'Cash-out', adjust: 'Ajuste' }[t.type];
          return `<div class="row"><div class="grow"><span class="badge">${label}</span><div class="when">${whenFull(t.created_at)}</div></div>
            <span class="amount ${isOut ? 'out' : 'in'}">${isOut ? '−' : '+'}${fmt(t.amount)}</span></div>`;
        }).join('') || '<p class="sub">Nenhum movimento nesta mesa.</p>'}</div>
      </div>
      <div class="card">
        <h3>🎁 Meus bônus</h3>
        <div class="list">${S.awards.filter(a => a.player_id === S.playerId).map(a => {
          const stt = bonusStatus(a);
          return `<div class="row"><div class="grow">${bIcon(a.type)} <strong>${fmt(a.amount)}</strong>
            <span class="badge ${stt.cls}">${stt.label}</span>
            <div class="when">${a.redeemed_at ? 'usado em ' + whenFull(a.redeemed_at) : a.expires_at ? 'vale até ' + whenFull(a.expires_at) : 'sem prazo'}</div></div></div>`;
        }).join('') || '<p class="sub">Você ainda não ganhou bônus — fique na mesa e acumule tempo de jogo!</p>'}</div>
        ${S.rules.filter(r => r.active).length ? `<p class="sub" style="margin:10px 0 0">${S.rules.filter(r => r.active).map(r =>
          `${bIcon(r.type)} ${esc(r.label)}: ${fmt(r.amount)} após ${hhmm(r.min_minutes)} de mesa (vale ${r.valid_days} dias)`).join(' · ')}</p>` : ''}
      </div>
      <h2>A mesa agora</h2>
      ${liveTiles(st)}`;
    bindSessionPicker();
  }

  // ---------- AO VIVO ----------
  function renderLive() {
    const st = stats();
    $app.innerHTML = `
      <h1>Mesa ao vivo ${st.c && st.c.status === 'open' ? '<span class="badge open">aberta</span>' : '<span class="badge">fechada</span>'}</h1>
      ${sessionPicker()}
      ${liveTiles(st)}
      <div class="card">
        <h3>Últimas mãos (rake)</h3>
        <div class="list">${S.rakes.slice(0, 10).map(r => `
          <div class="row"><div class="grow">${fmt(r.rake_amount)}
            ${r.pot_amount ? `<span class="badge">${(r.rake_amount / r.pot_amount * 100).toFixed(1)}% de ${fmt(r.pot_amount)}</span>` : ''}
            <div class="when">${when(r.created_at)}</div></div></div>`).join('') || '<p class="sub">Nenhuma mão registrada ainda.</p>'}</div>
      </div>
      <div class="card">
        <h3>Jogadores na mesa</h3>
        <div class="table-wrap"><table class="mini">
          <tr><th>Jogador</th><th>Comprou</th><th>Sacou</th></tr>
          ${S.players.map(p => {
            const ps = playerStats(p.id);
            if (!ps.buy && !ps.out) return '';
            return `<tr><td>${esc(p.name)}</td><td>${fmt(ps.buy)}</td><td>${fmt(ps.out)}</td></tr>`;
          }).join('') || ''}
        </table></div>
      </div>`;
    bindSessionPicker();
  }

  // ---------- PWA install ----------
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    document.getElementById('btn-install').classList.remove('hidden');
  });
  function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
  function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone; }
  async function tryInstall() {
    if (isStandalone()) return toast('O app já está instalado 🎉');
    if (deferredPrompt) { deferredPrompt.prompt(); const r = await deferredPrompt.userChoice; if (r.outcome === 'accepted') toast('App instalado!'); deferredPrompt = null; return; }
    if (isIOS()) return document.getElementById('ios-sheet').classList.remove('hidden');
    toast('No menu do navegador, use “Adicionar à tela inicial”.');
  }
  document.getElementById('btn-install').onclick = tryInstall;
  if (isIOS() && !isStandalone()) document.getElementById('btn-install').classList.remove('hidden');

  // ---------- navegação topo ----------
  document.getElementById('brand-home').onclick = () => go('home');
  document.getElementById('btn-logout').onclick = () => {
    S.role = null; S.adminPin = null; S.playerId = null; S.playerName = null;
    localStorage.removeItem('pk_role'); sessionStorage.removeItem('pk_admin_pin');
    localStorage.removeItem('pk_player_id'); localStorage.removeItem('pk_player_name');
    go('home');
  };

  // ---------- service worker ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---------- boot ----------
  (async function boot() {
    try { await loadAll(); } catch (e) { $app.innerHTML = '<div class="loading">Sem conexão com o banco. Verifique a internet.</div>'; return; }
    startRealtime();
    // atualiza "rake/hora" periodicamente
    S.timer = setInterval(() => { if (['admin', 'live', 'player'].includes(S.view)) render(); }, 60000);
    if (S.role === 'admin' && S.adminPin) S.view = 'admin';
    else if (S.role === 'player' && S.playerId) S.view = 'player';
    else S.view = 'home';
    render();
  })();
})();

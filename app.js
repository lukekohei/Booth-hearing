/* ブースヒアリング（オフラインPWA）
 * - データはこの端末のIndexedDBにのみ保存。外部送信は一切しない。
 * - ライブラリ不使用。
 */
'use strict';

const APP_VERSION = '1.0.0';

/* =====================================================================
 * 配信時の初期設定（仮の値）
 * ここを書き換えて配信し直すと、全端末の「初期値」が変わる。
 * ※端末の設定画面で変更済みの項目は端末側の値が優先される
 *   （設定画面「配信時の初期値に戻す」で、ここの値に戻せる）。
 * ※変更して配信するときは sw.js の VERSION も必ず上げること。
 * ===================================================================== */
const DEFAULT_CONFIG = {
  staff: ['担当A', '担当B', '担当C', '担当D', '担当E'],
  interests: ['テーマ1', 'テーマ2', 'テーマ3', 'テーマ4', 'テーマ5'],
  issues: ['課題1', '課題2', '課題3', '課題4', '課題5', '課題6'], // 「その他」は自動で末尾に付く
  forumId: { minLen: 6, maxLen: 6, charset: 'digits' },           // charset: 'digits' | 'alnum'
  surveyUrl: ''                                                    // 事務局アンケートURL（空なら非表示）
};

/* 仕様で固定の選択肢（変える場合はここを編集） */
const FIXED = {
  relations: ['既存取引先', 'グループ社員', 'パートナー', '新規'],
  phases: ['情報収集', '検討中', '具体案件あり'],
  nextActions: ['資料送付', '商談希望', 'デモ希望', '不要'],
  temps: [
    { v: 'A', hint: '前向き・早期フォロー' },
    { v: 'B', hint: '関心あり' },
    { v: 'C', hint: '情報収集程度' }
  ],
  otherLabel: 'その他',
  backupWarnMs: 2 * 60 * 60 * 1000
};

const CSV_HEADERS = ['レコードID', '端末ID', '連番', '保存時刻', 'フォーラムID', '対応担当者', '来場者との関係', '関心領域', '現在の課題', '検討フェーズ', '次アクション', '温度感', 'メモ', '更新時刻'];
const DB_NAME = 'booth-hearing';
const DB_VERSION = 1;
const DRAFT_KEY = 'booth-hearing-draft';

/* ------------------------------ 状態 ------------------------------ */
let db = null;
let deviceId = '';
let overrides = {};
let settings = structuredCloneSafe(DEFAULT_CONFIG);
let records = [];
let lastExport = null;          // { ms, kind, count, file }
let lastStaff = '';
let persistState = 'unknown';   // granted | denied | unsupported | unknown
let swReg = null;
let swVersion = '';
let userRequestedUpdate = false;
let editingId = null;
let saving = false;
let form = emptyForm();

/* ------------------------------ 小道具 ------------------------------ */
const $ = (s) => document.querySelector(s);
function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
function localISO(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
function hm(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function shortTime(ms) {
  const d = new Date(ms);
  return dayKey(ms) === dayKey(Date.now()) ? hm(ms) : `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`;
}
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  return `${h}時間${m % 60 ? (m % 60) + '分' : ''}前`;
}
function normalizeId(v) {
  return String(v || '')
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-‐－ー]/g, '')
    .toUpperCase();
}
function lines(text) {
  const out = [];
  for (const l of String(text || '').split(/\r?\n/)) { const t = l.trim(); if (t && !out.includes(t)) out.push(t); }
  return out;
}
const recTs = (r) => r.updatedMs || r.savedMs;

function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

/* ダイアログ：ボタンの onClick は「タップ直後に同期実行」される（共有シート等のユーザー操作要件のため） */
function dialog({ title, message, body, buttons, onOpen }) {
  return new Promise((resolve) => {
    const ov = el('div', { class: 'overlay' });
    const box = el('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' });
    if (title) box.append(el('h3', { text: title }));
    if (message) box.append(el('p', { class: 'msg', text: message }));
    if (body) box.append(el('div', { class: 'dlg-body' }, body));
    const bar = el('div', { class: 'btns' });
    const close = (v) => { ov.remove(); resolve(v); };
    for (const b of buttons) {
      const btn = el('button', { type: 'button', class: 'btn ' + (b.kind || ''), text: b.label, disabled: b.disabled || null });
      btn.addEventListener('click', () => {
        if (b.onClick && b.onClick(box) === false) return;
        close(b.value);
      });
      bar.append(btn);
    }
    box.append(bar);
    ov.append(box);
    $('#modal-root').append(ov);
    if (onOpen) onOpen(box);
  });
}
const alertDlg = (title, message) => dialog({ title, message, buttons: [{ label: 'OK', value: true, kind: 'pri' }] });
const confirmDlg = (title, message, okLabel = 'OK', okKind = 'pri') =>
  dialog({ title, message, buttons: [{ label: 'キャンセル', value: false }, { label: okLabel, value: true, kind: okKind }] });

/* ------------------------------ IndexedDB ------------------------------ */
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('records')) {
        const s = d.createObjectStore('records', { keyPath: 'id' });
        s.createIndex('forumId', 'forumId');
        s.createIndex('seq', 'seq');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('データベースが他のタブで使用中です。他のタブを閉じてください。'));
  });
}
function txDone(t) {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('処理が中断されました'));
  });
}
function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function metaGet(key) { const v = await reqP(db.transaction('meta').objectStore('meta').get(key)); return v ? v.value : undefined; }
async function metaSet(key, value) { const t = db.transaction('meta', 'readwrite'); t.objectStore('meta').put({ key, value }); await txDone(t); }
async function loadRecords() { records = await reqP(db.transaction('records').objectStore('records').getAll()); }

function insertRecord(data) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(['records', 'meta'], 'readwrite');
    const meta = t.objectStore('meta');
    let rec = null;
    const g = meta.get('seq');
    g.onsuccess = () => {
      const seq = (g.result ? g.result.value : 0) + 1;
      meta.put({ key: 'seq', value: seq });
      const now = new Date();
      rec = Object.assign({}, data, {
        id: `${deviceId}-${pad(seq, 4)}`,
        deviceId, seq,
        savedAt: localISO(now), savedMs: now.getTime(),
        updatedAt: '', updatedMs: 0
      });
      t.objectStore('records').add(rec); // IDが重複した場合は失敗し、トランザクションごと取り消される
    };
    t.oncomplete = () => resolve(rec);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('保存が中断されました'));
  });
}
async function updateRecord(id, data) {
  const t = db.transaction('records', 'readwrite');
  const s = t.objectStore('records');
  const cur = await reqP(s.get(id));
  if (!cur) throw new Error('対象の記録が見つかりません');
  const now = new Date();
  const rec = Object.assign({}, cur, data, { updatedAt: localISO(now), updatedMs: now.getTime() });
  s.put(rec);
  await txDone(t);
  return rec;
}
async function deleteRecord(id) { const t = db.transaction('records', 'readwrite'); t.objectStore('records').delete(id); await txDone(t); }

/* ------------------------------ 設定 ------------------------------ */
function applySettings() {
  settings = Object.assign(structuredCloneSafe(DEFAULT_CONFIG), structuredCloneSafe(overrides));
  settings.forumId = Object.assign({}, DEFAULT_CONFIG.forumId, overrides.forumId || {});
}
const issueOptions = () => settings.issues.concat([FIXED.otherLabel]);
function fidHint() {
  const f = settings.forumId;
  const kind = f.charset === 'alnum' ? '英数字' : '数字';
  return f.minLen === f.maxLen ? `${kind}${f.minLen}桁` : `${kind}${f.minLen}〜${f.maxLen}桁`;
}
function forumIdOk(v) {
  const f = settings.forumId;
  const re = f.charset === 'alnum' ? /^[A-Z0-9]+$/ : /^[0-9]+$/;
  return re.test(v) && v.length >= f.minLen && v.length <= f.maxLen;
}

/* ------------------------------ フォーム ------------------------------ */
function emptyForm() {
  return { forumId: '', staff: lastStaff || '', relation: '', interests: [], issues: [], phase: '', nextAction: '', temp: '', memo: '' };
}
function saveDraft() {
  if (editingId) return;
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch (e) { /* 使えなくても動作に影響なし */ }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* noop */ } }
function loadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && typeof d === 'object') form = Object.assign(emptyForm(), d);
  } catch (e) { /* noop */ }
}

const GROUPS = {
  staff: { el: '#grp-staff', opts: () => settings.staff, multi: false },
  relation: { el: '#grp-relation', opts: () => FIXED.relations, multi: false },
  interests: { el: '#grp-interests', opts: () => settings.interests, multi: true },
  issues: { el: '#grp-issues', opts: issueOptions, multi: true },
  phase: { el: '#grp-phase', opts: () => FIXED.phases, multi: false },
  nextAction: { el: '#grp-nextAction', opts: () => FIXED.nextActions, multi: false }
};

function renderGroup(key) {
  const g = GROUPS[key];
  const box = $(g.el);
  const opts = g.opts();
  const sel = g.multi ? form[key] : (form[key] ? [form[key]] : []);
  const all = opts.slice();
  for (const v of sel) if (!all.includes(v)) all.push(v);
  box.textContent = '';
  for (const opt of all) {
    const b = el('button', { type: 'button', class: 'chip' + (opts.includes(opt) ? '' : ' legacy'), 'aria-pressed': String(sel.includes(opt)), text: opt });
    b.addEventListener('click', () => {
      if (g.multi) {
        const i = form[key].indexOf(opt);
        if (i >= 0) form[key].splice(i, 1); else form[key].push(opt);
      } else {
        // 必須の担当者は再タップで解除しない（誤タップ防止）
        form[key] = (form[key] === opt && key !== 'staff') ? '' : opt;
      }
      if (key === 'staff' && form.staff && !editingId) {
        lastStaff = form.staff;
        metaSet('lastStaff', lastStaff).catch(() => {});
      }
      $('#fld-' + key).classList.remove('missing');
      renderGroup(key);
      saveDraft();
    });
    box.append(b);
  }
}
function renderTemp() {
  const box = $('#grp-temp');
  box.textContent = '';
  for (const t of FIXED.temps) {
    const b = el('button', { type: 'button', class: 'temp', 'data-v': t.v, 'aria-pressed': String(form.temp === t.v) },
      el('b', { text: t.v }), el('span', { text: t.hint }));
    b.addEventListener('click', () => {
      form.temp = t.v; // 必須項目のため再タップで解除しない
      $('#fld-temp').classList.remove('missing');
      renderTemp();
      saveDraft();
    });
    box.append(b);
  }
}
function renderForumIdMsg() {
  const v = form.forumId;
  const input = $('#in-forumId');
  const msg = $('#fid-msg');
  input.classList.toggle('bad', !!v && !forumIdOk(v));
  const dups = v ? records.filter((r) => r.forumId === v && r.id !== editingId) : [];
  if (!v) { msg.className = 'fmsg'; msg.textContent = ''; return; }
  const parts = [];
  let cls = 'ok';
  if (!forumIdOk(v)) { parts.push(`形式が「${fidHint()}」と一致しません（このまま保存も可能）`); cls = 'warn'; }
  if (dups.length) { parts.push(`このIDは保存済みです（${dups.length}件）`); cls = 'dng'; }
  msg.className = 'fmsg ' + cls;
  msg.textContent = parts.length ? '⚠ ' + parts.join(' ／ ') : '✓ 形式OK';
}
function renderForm() {
  const input = $('#in-forumId');
  input.value = form.forumId;
  const alnum = settings.forumId.charset === 'alnum';
  input.setAttribute('inputmode', alnum ? 'text' : 'numeric');
  input.setAttribute('autocapitalize', alnum ? 'characters' : 'off');
  input.placeholder = '0'.repeat(Math.min(settings.forumId.maxLen, 10));
  $('#fid-hint').textContent = fidHint();
  renderForumIdMsg();
  Object.keys(GROUPS).forEach(renderGroup);
  renderTemp();
  $('#in-memo').value = form.memo;
  document.querySelectorAll('.field.missing').forEach((f) => f.classList.remove('missing'));
  // 編集モード表示
  $('#edit-banner').hidden = !editingId;
  $('#edit-id').textContent = editingId || '';
  $('#btn-save').textContent = editingId ? '更新する' : '保存する';
  $('#btn-delete').hidden = !editingId;
  $('#btn-undo').hidden = !!editingId;
  $('#btn-undo').disabled = !records.length;
}
function buildKeypad() {
  const kp = $('#keypad');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '⌫', 'クリア'];
  for (const k of keys) {
    const b = el('button', { type: 'button', tabindex: '-1', text: k, class: k === '⌫' ? 'k-bs' : (k === 'クリア' ? 'k-clr' : null), 'aria-label': k === '⌫' ? '1文字消す' : k });
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // 入力欄のフォーカスを奪わない
    b.addEventListener('click', () => {
      if (k === '⌫') form.forumId = form.forumId.slice(0, -1);
      else if (k === 'クリア') form.forumId = '';
      else if (form.forumId.length < 30) form.forumId += k;
      $('#in-forumId').value = form.forumId;
      $('#fld-forumId').classList.remove('missing');
      renderForumIdMsg();
      saveDraft();
    });
    kp.append(b);
  }
}

function collectForm() {
  return {
    forumId: normalizeId(form.forumId),
    staff: form.staff,
    relation: form.relation,
    interests: form.interests.slice(),
    issues: form.issues.slice(),
    phase: form.phase,
    nextAction: form.nextAction,
    temp: form.temp,
    memo: String(form.memo || '').trim()
  };
}
function resetForm() {
  const wasEditing = !!editingId;
  editingId = null;
  form = emptyForm();
  if (wasEditing) loadDraft(); // 編集前に入力途中だった新規分を復元
  else clearDraft();
  renderForm();
  window.scrollTo(0, 0);
}

async function onSave() {
  if (saving) return;
  saving = true;
  try {
    const data = collectForm();
    const missing = [];
    if (!data.forumId) missing.push(['forumId', 'フォーラムID']);
    if (!data.staff) missing.push(['staff', '対応担当者']);
    if (!data.temp) missing.push(['temp', '温度感']);
    if (missing.length) {
      missing.forEach(([k]) => $('#fld-' + k).classList.add('missing'));
      $('#fld-' + missing[0][0]).scrollIntoView({ behavior: 'smooth', block: 'center' });
      await alertDlg('必須項目が未入力です', missing.map((m) => '・' + m[1]).join('\n'));
      return;
    }
    if (!forumIdOk(data.forumId)) {
      const ok = await dialog({
        title: 'フォーラムIDの形式が違います',
        message: `入力：${data.forumId}（${data.forumId.length}桁）\n想定：${fidHint()}\n\nこのまま保存しますか？`,
        buttons: [{ label: '修正する', value: false }, { label: 'このまま保存', value: true, kind: 'warn' }]
      });
      if (!ok) return;
    }
    const dups = records.filter((r) => r.forumId === data.forumId && r.id !== editingId).sort((a, b) => b.savedMs - a.savedMs);
    if (dups.length) {
      const latest = dups[0];
      const r = await dialog({
        title: '同じフォーラムIDが保存済みです',
        message: `フォーラムID ${data.forumId} はすでに ${dups.length} 件あります。\n直近：${shortTime(latest.savedMs)}　${latest.staff}　温度感${latest.temp}`,
        buttons: [
          { label: 'キャンセル', value: 'cancel' },
          { label: '既存を確認', value: 'check' },
          { label: '別件として保存', value: 'save', kind: 'warn' }
        ]
      });
      if (r === 'check') { $('#list-q').value = data.forumId; showTab('list'); return; }
      if (r !== 'save') return;
    }

    if (editingId) {
      const rec = await updateRecord(editingId, data);
      const i = records.findIndex((x) => x.id === rec.id);
      if (i >= 0) records[i] = rec;
      toast(`更新しました（${rec.id}）`);
    } else {
      const rec = await insertRecord(data);
      records.push(rec);
      toast(`保存しました（${rec.id}）`);
    }
    resetForm();
    refreshAll();
  } catch (e) {
    await alertDlg('保存に失敗しました', (e && e.message) || String(e));
  } finally {
    saving = false;
  }
}

async function onUndo() {
  if (!records.length) return;
  const last = records.slice().sort((a, b) => b.seq - a.seq)[0];
  const ok = await confirmDlg('直前の1件を取り消しますか？',
    `${last.id}\nフォーラムID ${last.forumId}　${last.staff}　温度感${last.temp}　${shortTime(last.savedMs)}\n\nこの記録は削除され、元に戻せません。`, '取り消す', 'dng');
  if (!ok) return;
  try {
    await deleteRecord(last.id);
    records = records.filter((r) => r.id !== last.id);
    toast(`取り消しました（${last.id}）`);
    refreshAll();
    renderForm();
  } catch (e) { alertDlg('取り消しに失敗しました', e.message); }
}

async function onDeleteEditing() {
  const rec = records.find((r) => r.id === editingId);
  if (!rec) return;
  const ok = await confirmDlg('この記録を削除しますか？', `${rec.id}\nフォーラムID ${rec.forumId}　${rec.staff}　${shortTime(rec.savedMs)}\n\n元に戻せません。`, '削除する', 'dng');
  if (!ok) return;
  try {
    await deleteRecord(rec.id);
    records = records.filter((r) => r.id !== rec.id);
    toast(`削除しました（${rec.id}）`);
    resetForm();
    refreshAll();
    showTab('list');
  } catch (e) { alertDlg('削除に失敗しました', e.message); }
}

function startEdit(id) {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  saveDraft(); // 入力途中の新規分は下書きに残す
  editingId = id;
  form = {
    forumId: rec.forumId, staff: rec.staff, relation: rec.relation || '',
    interests: (rec.interests || []).slice(), issues: (rec.issues || []).slice(),
    phase: rec.phase || '', nextAction: rec.nextAction || '', temp: rec.temp, memo: rec.memo || ''
  };
  showTab('input');
  renderForm();
  window.scrollTo(0, 0);
}
function cancelEdit() {
  editingId = null;
  form = emptyForm();
  loadDraft();
  renderForm();
  showTab('list');
}

/* ------------------------------ 一覧 ------------------------------ */
function renderList() {
  const q = normalizeId($('#list-q').value);
  const rows = $('#rows');
  rows.textContent = '';
  const list = records
    .filter((r) => !q || r.forumId.includes(q))
    .sort((a, b) => (b.savedMs - a.savedMs) || (b.seq - a.seq));
  if (!list.length) {
    rows.append(el('div', { class: 'empty', text: q ? `「${q}」に一致する記録はありません` : 'まだ記録がありません' }));
    return;
  }
  for (const r of list) {
    const row = el('button', { type: 'button', class: 'row', 'aria-label': `${r.forumId} を編集` },
      el('span', { class: 't', text: shortTime(r.savedMs) }),
      el('span', { class: 'fid' }, r.forumId, r.updatedMs ? el('span', { class: 'edited', text: '編集済' }) : null),
      el('span', {}, el('span', { class: 'tb ' + r.temp, text: r.temp })),
      el('span', { text: r.staff }),
      el('span', { class: 'rel', text: r.relation || '—' }),
      el('span', { class: 'rid', text: r.id })
    );
    row.addEventListener('click', () => startEdit(r.id));
    rows.append(row);
  }
}

/* ------------------------------ ステータス表示 ------------------------------ */
function unexported() {
  const w = lastExport ? lastExport.ms : 0;
  return records.filter((r) => recTs(r) > w);
}
function backupState() {
  const un = unexported();
  const base = lastExport ? lastExport.ms : (un.length ? Math.min(...un.map((r) => r.savedMs)) : Date.now());
  const warn = un.length > 0 && Date.now() - base >= FIXED.backupWarnMs;
  return { un, warn };
}
function refreshStatus() {
  const today = dayKey(Date.now());
  $('#st-today').textContent = records.filter((r) => dayKey(r.savedMs) === today).length;
  $('#st-device').textContent = deviceId || '未設定';
  const { un, warn } = backupState();
  const b = $('#st-backup');
  $('#st-backup-time').textContent = lastExport ? `${shortTime(lastExport.ms)}（${ago(lastExport.ms)}）` : '未実施';
  $('#st-backup-sub').textContent = warn
    ? `⚠ ${lastExport ? '2時間以上経過' : '未バックアップ'}・未書き出し${un.length}件 — タップしてCSV書き出し`
    : (un.length ? `未書き出し ${un.length}件 — タップで書き出し` : '未書き出しなし');
  b.classList.toggle('warn', warn);
  $('#tab-list-count').textContent = `(${records.length})`;
  $('#btn-undo').disabled = !records.length;
  $('#btn-survey').hidden = !settings.surveyUrl;
  // 設定画面の表示
  $('#set-count').textContent = `${records.length}件`;
  $('#set-unexported').textContent = `${un.length}件`;
  $('#set-lastexport').textContent = lastExport
    ? `${localISO(new Date(lastExport.ms)).slice(0, 16).replace('T', ' ')}（${lastExport.kind === 'all' ? '全件' : '差分'} ${lastExport.count}件）`
    : '未実施';
  const needAttention = persistState === 'denied' || (swReg && swReg.waiting);
  $('#tab-settings-badge').hidden = !needAttention;
}
function refreshAll() {
  refreshStatus();
  renderList();
  renderForumIdMsg();
}

/* ------------------------------ CSV ------------------------------ */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // Excelでの数式解釈（CSVインジェクション）防止
  return '"' + s.replace(/"/g, '""') + '"';
}
function buildCsv(list) {
  const rows = [CSV_HEADERS.map(csvCell).join(',')];
  for (const r of list.slice().sort((a, b) => a.seq - b.seq)) {
    rows.push([
      r.id, r.deviceId, r.seq, r.savedAt, r.forumId, r.staff, r.relation,
      (r.interests || []).join(';'), (r.issues || []).join(';'),
      r.phase, r.nextAction, r.temp, r.memo, r.updatedAt || ''
    ].map(csvCell).join(','));
  }
  return '﻿' + rows.join('\r\n') + '\r\n';
}
function makeCsvFile(list, kind, stampMs) {
  const d = new Date(stampMs);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = `hearing_${deviceId}_${stamp}_${kind === 'all' ? '全件' : '差分'}.csv`;
  const blob = new Blob([buildCsv(list)], { type: 'text/csv;charset=utf-8' });
  try { return new File([blob], name, { type: 'text/csv' }); } catch (e) { blob.name = name; return blob; }
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = el('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
/* navigator.share はタップ直後に同期的に呼ぶ必要があるため、await より前で呼ぶ */
function deliverFile(file) {
  if (navigator.canShare && navigator.share && file instanceof File) {
    let can = false;
    try { can = navigator.canShare({ files: [file] }); } catch (e) { can = false; }
    if (can) {
      return navigator.share({ files: [file], title: file.name })
        .then(() => 'shared')
        .catch((e) => {
          if (e && e.name === 'AbortError') return 'cancel';
          downloadFile(file);
          return 'downloaded';
        });
    }
  }
  downloadFile(file);
  return Promise.resolve('downloaded');
}
async function recordExport(kind, count, file, watermark) {
  lastExport = { ms: watermark, kind, count, file: file.name };
  await metaSet('lastExport', lastExport);
  refreshStatus();
}
function openExport() {
  if (!records.length) { alertDlg('書き出す記録がありません', 'まだ保存された記録がありません。'); return; }
  const watermark = Date.now();
  const diff = unexported();
  const all = records.slice();
  const files = {
    diff: diff.length ? makeCsvFile(diff, 'diff', watermark) : null,
    all: makeCsvFile(all, 'all', watermark)
  };
  const go = (kind, count) => () => {
    const file = files[kind];
    deliverFile(file).then(async (res) => {
      if (res === 'cancel') { toast('書き出しをキャンセルしました'); return; }
      await recordExport(kind, count, file, watermark);
      toast(`${kind === 'all' ? '全件' : '差分'} ${count}件を書き出しました`);
    }).catch((e) => alertDlg('書き出しに失敗しました', e.message));
  };
  const shareNote = (navigator.canShare && navigator.share)
    ? '共有シートが開きます。「ファイルに保存」「AirDrop」「メール」などを選んでください。'
    : 'この環境では共有機能が使えないため、ダウンロードします。';
  dialog({
    title: 'CSV書き出し（バックアップ）',
    message: `全 ${all.length}件 ／ 前回書き出し以降 ${diff.length}件\n${lastExport ? '前回：' + shortTime(lastExport.ms) : '前回：未実施'}\n\n${shareNote}`,
    buttons: [
      { label: '閉じる', value: null },
      { label: `全件（${all.length}件）`, value: 'all', onClick: go('all', all.length) },
      { label: `差分のみ（${diff.length}件）`, value: 'diff', kind: 'pri', disabled: !diff.length, onClick: go('diff', diff.length) }
    ]
  });
}

/* ------------------------------ タブ ------------------------------ */
function showTab(name) {
  document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $('#view-input').hidden = name !== 'input';
  $('#view-list').hidden = name !== 'list';
  $('#view-settings').hidden = name !== 'settings';
  $('#actionbar').hidden = name !== 'input';
  if (name === 'list') renderList();
  if (name === 'settings') { fillSettings(); refreshStorageInfo(); }
  window.scrollTo(0, 0);
}

/* ------------------------------ 設定画面 ------------------------------ */
let fidCharsetDraft = 'digits';
function fillSettings() {
  $('#set-device').value = deviceId;
  $('#set-staff').value = settings.staff.join('\n');
  $('#set-interests').value = settings.interests.join('\n');
  $('#set-issues').value = settings.issues.join('\n');
  $('#set-fid-min').value = settings.forumId.minLen;
  $('#set-fid-max').value = settings.forumId.maxLen;
  fidCharsetDraft = settings.forumId.charset;
  renderCharsetSeg();
  $('#set-survey').value = settings.surveyUrl || '';
  refreshStatus();
}
function renderCharsetSeg() {
  document.querySelectorAll('#set-fid-charset button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === fidCharsetDraft)));
}
async function onSaveSettings() {
  const staff = lines($('#set-staff').value);
  const interests = lines($('#set-interests').value);
  const issues = lines($('#set-issues').value).filter((x) => x !== FIXED.otherLabel);
  const minLen = parseInt($('#set-fid-min').value, 10);
  const maxLen = parseInt($('#set-fid-max').value, 10);
  const survey = $('#set-survey').value.trim();
  const errs = [];
  if (!staff.length) errs.push('担当者を1名以上入力してください');
  if (!interests.length) errs.push('関心領域を1つ以上入力してください');
  if (!issues.length) errs.push('現在の課題を1つ以上入力してください');
  if (!(minLen >= 1 && minLen <= 30 && maxLen >= 1 && maxLen <= 30 && minLen <= maxLen)) errs.push('桁数は1〜30で、最小≦最大にしてください');
  if (survey && !/^https:\/\/\S+$/i.test(survey)) errs.push('アンケートURLは https:// で始まる形式にしてください');
  if (errs.length) { alertDlg('設定を保存できません', errs.join('\n')); return; }
  const warns = [];
  if (issues.length < 5 || issues.length > 8) warns.push(`現在の課題が${issues.length}個です（推奨5〜8個）`);
  if (warns.length && !(await confirmDlg('確認', warns.join('\n') + '\n\nこのまま保存しますか？', '保存する'))) return;

  const next = { staff, interests, issues, forumId: { minLen, maxLen, charset: fidCharsetDraft }, surveyUrl: survey };
  // 初期値と同じ項目は上書き扱いにしない（配信側の初期値変更を反映させるため）
  const ov = {};
  for (const k of Object.keys(next)) if (JSON.stringify(next[k]) !== JSON.stringify(DEFAULT_CONFIG[k])) ov[k] = next[k];
  try {
    await metaSet('settings', ov);
    overrides = ov;
    applySettings();
    if (lastStaff && !settings.staff.includes(lastStaff)) { lastStaff = ''; await metaSet('lastStaff', ''); }
    if (!editingId && form.staff && !settings.staff.includes(form.staff)) form.staff = '';
    renderForm();
    refreshStatus();
    toast('設定を保存しました');
  } catch (e) { alertDlg('設定の保存に失敗しました', e.message); }
}
async function onResetSettings() {
  if (!(await confirmDlg('初期値に戻しますか？', '担当者名簿・関心領域・課題・フォーラムID形式・アンケートURLを、配信時の初期値に戻します。\n（端末ID・保存済みの記録はそのままです）', '初期値に戻す'))) return;
  await metaSet('settings', {});
  overrides = {};
  applySettings();
  if (lastStaff && !settings.staff.includes(lastStaff)) { lastStaff = ''; await metaSet('lastStaff', ''); }
  fillSettings();
  renderForm();
  toast('初期値に戻しました');
}
const DEVICE_RE = /^[A-Za-z0-9_-]{1,20}$/;
async function onSaveDevice() {
  const v = $('#set-device').value.trim();
  if (!DEVICE_RE.test(v)) { alertDlg('端末IDの形式', '半角英数字・ハイフン・アンダースコアの1〜20文字で入力してください（例：iPad-01）'); return; }
  if (v === deviceId) return;
  const ok = await confirmDlg('端末IDを変更しますか？',
    `${deviceId} → ${v}\n\n他の端末と同じIDにしないでください。\n保存済み${records.length}件のIDは変わりません。連番は引き続き増えます。`, '変更する', 'warn');
  if (!ok) { $('#set-device').value = deviceId; return; }
  await metaSet('deviceId', v);
  deviceId = v;
  refreshStatus();
  toast('端末IDを変更しました');
}
async function onWipe() {
  const first = await confirmDlg('全データを削除しますか？（1/2）',
    `この端末の記録 ${records.length}件（未書き出し ${unexported().length}件）をすべて削除します。\n元に戻せません。先に全件CSVを書き出しましたか？`, '次へ', 'dng');
  if (!first) return;
  const input = el('input', { type: 'text', autocomplete: 'off', placeholder: '削除', 'aria-label': '確認のため「削除」と入力' });
  const err = el('div', { class: 'dlg-err' });
  const second = await dialog({
    title: '最終確認（2/2）',
    message: '確認のため、下の欄に「削除」と入力してください。',
    body: el('div', {}, input, err),
    buttons: [
      { label: 'やめる', value: false },
      { label: 'すべて削除する', value: true, kind: 'dng', onClick: () => { if (input.value.trim() !== '削除') { err.textContent = '「削除」と入力してください'; return false; } return true; } }
    ]
  });
  if (!second) return;
  try {
    const t = db.transaction(['records', 'meta'], 'readwrite');
    t.objectStore('records').clear();
    t.objectStore('meta').delete('lastExport'); // 連番(seq)と端末ID・設定は残す
    await txDone(t);
    records = [];
    lastExport = null;
    resetForm();
    refreshAll();
    toast('全データを削除しました');
  } catch (e) { alertDlg('削除に失敗しました', e.message); }
}

/* ------------------------------ ストレージ・更新 ------------------------------ */
const isStandalone = () => window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches;
async function checkPersist(forceRequest) {
  try {
    if (!navigator.storage || !navigator.storage.persist) { persistState = 'unsupported'; return; }
    let p = await navigator.storage.persisted();
    if (!p || forceRequest) p = await navigator.storage.persist();
    persistState = p ? 'granted' : 'denied';
  } catch (e) { persistState = 'unsupported'; }
}
async function refreshStorageInfo() {
  const pEl = $('#set-persist');
  const warn = $('#set-persist-warn');
  const map = {
    granted: '✓ 有効（ブラウザの自動削除の対象外）',
    denied: '✕ 未許可（ストレージ逼迫時に消える可能性あり）',
    unsupported: '— このブラウザは未対応（こまめにCSV書き出しを）',
    unknown: '確認中…'
  };
  pEl.textContent = map[persistState];
  pEl.style.color = persistState === 'granted' ? 'var(--ok)' : (persistState === 'denied' ? 'var(--dng)' : '');
  warn.hidden = persistState !== 'denied' && persistState !== 'unsupported';
  warn.textContent = persistState === 'denied'
    ? '⚠ ストレージの永続化が許可されていません。端末の空き容量が不足すると、データが削除される可能性があります。ホーム画面から起動して「永続化を再要求」を押し、こまめにCSV書き出しを行ってください。'
    : '⚠ この環境ではストレージの永続化を確認できません。こまめにCSV書き出しを行ってください。';
  $('#set-mode').textContent = isStandalone() ? 'ホーム画面アプリ' : 'ブラウザのタブ';
  $('#set-standalone-warn').hidden = isStandalone();
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
      $('#set-usage').textContent = `${mb(e.usage || 0)} 使用${e.quota ? ' ／ 上限目安 ' + mb(e.quota) : ''}`;
    }
  } catch (e) { /* noop */ }
  $('#set-version').textContent = `app ${APP_VERSION}${swVersion ? ' ／ キャッシュ ' + swVersion : ''}`;
  renderUpdateState();
  refreshStatus();
}
function renderUpdateState(msg) {
  const waiting = swReg && swReg.waiting;
  $('#btn-apply-update').hidden = !waiting;
  $('#set-update').textContent = msg || (!('serviceWorker' in navigator) ? 'Service Worker非対応'
    : waiting ? '新しいバージョンがあります（入力中でないときに更新）'
    : swReg ? '最新（オフライン対応済み）' : '準備中…');
}
function setupSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    swReg = reg;
    const track = (w) => w && w.addEventListener('statechange', () => { renderUpdateState(); refreshStatus(); });
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    renderUpdateState();
    refreshStatus();
    askVersion();
  }).catch(() => renderUpdateState('登録失敗（https配信か確認）'));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'VERSION') { swVersion = e.data.version; if (!$('#view-settings').hidden) refreshStorageInfo(); }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (userRequestedUpdate) { userRequestedUpdate = false; location.reload(); }
    else askVersion();
  });
}
function askVersion() { if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage('GET_VERSION'); }
async function onCheckUpdate() {
  if (!swReg) return;
  renderUpdateState('確認中…');
  try { await swReg.update(); } catch (e) { renderUpdateState('確認できませんでした（オフライン？）'); return; }
  setTimeout(() => renderUpdateState(swReg.installing ? 'ダウンロード中…' : null), 800);
  setTimeout(() => renderUpdateState(), 3000);
}
async function onApplyUpdate() {
  if (!swReg || !swReg.waiting) return;
  if (!(await confirmDlg('アプリを更新しますか？', '画面を再読み込みします。保存済みの記録は消えません。\n（入力途中の内容は下書きとして残ります）', '更新する'))) return;
  saveDraft();
  userRequestedUpdate = true;
  swReg.waiting.postMessage('SKIP_WAITING');
}

/* ------------------------------ 初回：端末ID ------------------------------ */
async function askDeviceId() {
  const input = el('input', { type: 'text', value: 'iPad-01', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': '端末ID' });
  const err = el('div', { class: 'dlg-err' });
  await dialog({
    title: 'この端末のIDを設定してください',
    message: '端末ごとに重複しない名前にします（例：iPad-01, iPad-02）。\n記録のIDは「端末ID-連番」になり、複数台のCSVを結合しても重複しません。',
    body: el('div', {}, input, err),
    buttons: [{
      label: 'この端末IDで始める', value: true, kind: 'pri',
      onClick: () => { if (!DEVICE_RE.test(input.value.trim())) { err.textContent = '半角英数字・-・_ の1〜20文字で入力してください'; return false; } return true; }
    }]
  });
  deviceId = input.value.trim();
  await metaSet('deviceId', deviceId);
}

/* ------------------------------ 起動 ------------------------------ */
function bindEvents() {
  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.tab === 'list' && editingId) { cancelEdit(); return; }
    showTab(b.dataset.tab);
  }));
  const fid = $('#in-forumId');
  fid.addEventListener('input', () => {
    const v = normalizeId(fid.value);
    if (v !== fid.value) fid.value = v;
    form.forumId = v;
    $('#fld-forumId').classList.remove('missing');
    renderForumIdMsg();
    saveDraft();
  });
  fid.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fid.blur(); } });
  $('#in-memo').addEventListener('input', (e) => { form.memo = e.target.value; saveDraft(); });
  $('#btn-save').addEventListener('click', onSave);
  $('#btn-undo').addEventListener('click', onUndo);
  $('#btn-delete').addEventListener('click', onDeleteEditing);
  $('#btn-edit-cancel').addEventListener('click', cancelEdit);
  $('#st-backup').addEventListener('click', openExport);
  $('#btn-export').addEventListener('click', openExport);
  $('#list-q').addEventListener('input', renderList);
  $('#btn-list-clear').addEventListener('click', () => { $('#list-q').value = ''; renderList(); });
  $('#btn-save-settings').addEventListener('click', onSaveSettings);
  $('#btn-reset-settings').addEventListener('click', onResetSettings);
  $('#btn-save-device').addEventListener('click', onSaveDevice);
  $('#btn-wipe').addEventListener('click', onWipe);
  $('#btn-persist').addEventListener('click', async () => { await checkPersist(true); refreshStorageInfo(); });
  $('#btn-check-update').addEventListener('click', onCheckUpdate);
  $('#btn-apply-update').addEventListener('click', onApplyUpdate);
  document.querySelectorAll('#set-fid-charset button').forEach((b) => b.addEventListener('click', () => { fidCharsetDraft = b.dataset.v; renderCharsetSeg(); }));
  $('#btn-survey').addEventListener('click', () => {
    const url = settings.surveyUrl;
    if (!url) return;
    dialog({
      title: '事務局アンケートを開きますか？',
      message: '外部のページが開きます（通信が必要です）。\n終わったらこのアプリに戻ってください。',
      buttons: [
        { label: 'キャンセル', value: false },
        { label: '開く', value: true, kind: 'pri', onClick: () => { window.open(url, '_blank', 'noopener'); } }
      ]
    });
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  setInterval(refreshStatus, 30000);
}

async function init() {
  buildKeypad();
  bindEvents();
  $('#standalone-banner').hidden = isStandalone();
  try {
    db = await openDB();
  } catch (e) {
    await alertDlg('データベースを開けません', (e && e.message) || String(e));
    return;
  }
  await checkPersist(false);
  overrides = (await metaGet('settings')) || {};
  applySettings();
  deviceId = (await metaGet('deviceId')) || '';
  lastExport = (await metaGet('lastExport')) || null;
  lastStaff = (await metaGet('lastStaff')) || '';
  if (lastStaff && !settings.staff.includes(lastStaff)) lastStaff = '';
  await loadRecords();
  form = emptyForm();
  loadDraft();
  renderForm();
  refreshAll();
  setupSW();
  if (!deviceId) { await askDeviceId(); refreshStatus(); }
  if (persistState === 'denied') refreshStatus();
}

init();

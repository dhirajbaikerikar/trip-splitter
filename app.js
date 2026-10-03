(function () {
  'use strict';

  // ------------------------------------------------------------------ helpers
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.className = 'show';
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.className = ''; }, 2800);
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('Could not copy'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else fallback();
  }
  function fmtDay(s) {
    try {
      return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    } catch (e) { return s; }
  }
  function fmtShort(s) {
    try { return new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); } catch (e) { return s; }
  }

  // ------------------------------------------------------------------ config + API
  var cfg = null;
  function getCfg() {
    var c = window.APP_CONFIG || {};
    if (c.SUPABASE_URL && c.SUPABASE_KEY) return { url: c.SUPABASE_URL, key: c.SUPABASE_KEY };
    var l = LS.get('ts_cfg', null);
    if (l && l.url && l.key) return l;
    return null;
  }

  var ERRORS = {
    trip_not_found: 'This trip was not found. Check the link or code.',
    person_in_use: 'This person is used in some expenses. Delete or edit those expenses first.',
    split_empty: 'Pick at least one person to split with.',
    payer_not_in_trip: 'The person who paid is not part of this trip.',
    split_person_not_in_trip: 'Someone in the split is not part of this trip.',
    expense_not_found: 'That expense no longer exists. Refresh the page.',
    item_not_found: 'That itinerary item no longer exists. Refresh the page.'
  };
  function friendly(msg) {
    msg = String(msg || '');
    for (var k in ERRORS) if (msg.indexOf(k) >= 0) return ERRORS[k];
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'No internet connection, or the Supabase URL is wrong.';
    if (/Invalid API key|JWT/i.test(msg)) return 'The Supabase key looks wrong. Use the anon / publishable key.';
    if (/Could not find the function/i.test(msg)) return 'Database not set up yet. Run supabase/schema.sql in Supabase.';
    return msg || 'Something went wrong.';
  }
  function rpc(fn, args) {
    return fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!r.ok) throw new Error(friendly((data && (data.message || data.hint)) || text || r.statusText));
        return data;
      });
    }, function (e) { throw new Error(friendly(e && e.message)); });
  }

  // ------------------------------------------------------------------ money + split maths (all in paise/cents)
  function cents(x) { return Math.round(Number(x) * 100); }
  function money(c) {
    var cur = (T && T.trip.currency) || '₹';
    var v = Math.abs(c) / 100, s;
    s = Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (c < 0 ? '-' : '') + cur + s;
  }
  function compute(t) {
    var res = {}, order = t.people.map(function (p) { return p.id; });
    order.forEach(function (id) { res[id] = { paid: 0, share: 0, settled: 0, net: 0 }; });
    var total = 0, byCat = {};
    t.expenses.forEach(function (e) {
      var amt = cents(e.amount);
      var ids = order.filter(function (id) { return (e.split_between || []).indexOf(id) >= 0; });
      if (!ids.length || !res[e.paid_by]) return;
      var base = Math.floor(amt / ids.length), rem = amt - base * ids.length;
      if (e.kind === 'payment') {
        res[e.paid_by].settled += amt;
        ids.forEach(function (id, i) { res[id].settled -= base + (i < rem ? 1 : 0); });
      } else {
        total += amt; byCat[e.category] = (byCat[e.category] || 0) + amt;
        res[e.paid_by].paid += amt;
        ids.forEach(function (id, i) { res[id].share += base + (i < rem ? 1 : 0); });
      }
    });
    order.forEach(function (id) { res[id].net = res[id].paid - res[id].share + res[id].settled; });
    return { per: res, total: total, byCat: byCat };
  }
  function settle(per) {
    var cr = [], db = [], out = [];
    Object.keys(per).forEach(function (id) {
      if (per[id].net > 0) cr.push({ id: id, v: per[id].net });
      else if (per[id].net < 0) db.push({ id: id, v: -per[id].net });
    });
    while (cr.length && db.length) {
      cr.sort(function (a, b) { return b.v - a.v; });
      db.sort(function (a, b) { return b.v - a.v; });
      var x = Math.min(cr[0].v, db[0].v);
      out.push({ from: db[0].id, to: cr[0].id, amt: x });
      cr[0].v -= x; db[0].v -= x;
      if (cr[0].v <= 0) cr.shift();
      if (db[0].v <= 0) db.shift();
    }
    return out;
  }

  // ------------------------------------------------------------------ state
  var T = null, code = null, tab = 'balances', lastJson = '', pollTimer = null, busy = false;
  var CATS = ['Stay', 'Food & Drinks', 'Fuel', 'Toll', 'Travel', 'Activities', 'Shopping', 'Parking', 'Other'];

  function pname(id) {
    if (!T) return '';
    for (var i = 0; i < T.people.length; i++) if (T.people[i].id === id) return T.people[i].name;
    return '(removed)';
  }
  function myTrips() { return LS.get('ts_trips', []); }
  function rememberTrip(c, name) {
    var l = myTrips().filter(function (t) { return t.code !== c; });
    l.unshift({ code: c, name: name });
    LS.set('ts_trips', l.slice(0, 50));
  }
  function forgetTrip(c) { LS.set('ts_trips', myTrips().filter(function (t) { return t.code !== c; })); }
  function shareLink() { return location.href.split('#')[0] + '#/t/' + code; }

  // ------------------------------------------------------------------ views
  function renderSetup() {
    $('#app').innerHTML =
      '<header class="top"><h1>Trip Splitter</h1><p>One-time setup</p></header><main>' +
      '<div class="card"><h2>Connect your Supabase project</h2>' +
      '<p class="hint">Find both values in Supabase: Project Settings, then API. Use the <b>anon / publishable</b> key, never the secret key.</p>' +
      '<form data-form="setup"><label>Project URL</label><input name="url" placeholder="https://abcdxyz.supabase.co" required>' +
      '<label>Anon / publishable key</label><input name="key" placeholder="eyJ... or sb_publishable_..." required>' +
      '<div class="btnrow"><button class="btn" type="submit">Save and continue</button></div></form></div></main>';
  }

  function renderHome() {
    var trips = myTrips();
    var list = trips.length ? trips.map(function (t) {
      return '<div class="tripbtn" data-act="openTrip" data-code="' + esc(t.code) + '"><span class="grow">' + esc(t.name) + '</span>' +
        '<button class="btn ghost small" data-act="forgetTrip" data-code="' + esc(t.code) + '">Remove</button></div>';
    }).join('') : '<div class="empty">No trips yet. Create one below, or join with a link.</div>';
    $('#app').innerHTML =
      '<header class="top"><h1>Trip Splitter</h1><p>Plan trips, track expenses, settle up</p></header><main>' +
      '<div class="card"><h2>Your trips</h2>' + list + '</div>' +
      '<div class="card"><h2>Create a new trip</h2><form data-form="createTrip">' +
      '<label>Trip name</label><input name="name" maxlength="80" placeholder="e.g. Goa weekend" required>' +
      '<div class="row"><div><label>Currency</label><select name="currency"><option>₹</option><option>$</option><option>€</option><option>£</option><option>¥</option></select></div>' +
      '<div><label>Start date (optional)</label><input type="date" name="start"></div>' +
      '<div><label>End date (optional)</label><input type="date" name="end"></div></div>' +
      '<label>People (one name per line, you can add more later)</label>' +
      '<textarea name="people" placeholder="Dhiraj&#10;Priya&#10;Akshay"></textarea>' +
      '<div class="btnrow"><button class="btn" type="submit">Create trip</button></div></form></div>' +
      '<div class="card"><h2>Join a trip</h2><p class="hint">Paste the trip link someone shared with you.</p>' +
      '<form data-form="joinTrip"><input name="link" placeholder="Paste trip link or code" required>' +
      '<div class="btnrow"><button class="btn ghost" type="submit">Open trip</button></div></form></div></main>';
  }

  function renderTrip() {
    if (!T) return;
    var c = compute(T), sy = window.scrollY;
    var dates = T.trip.start_date ? (fmtShort(T.trip.start_date) + (T.trip.end_date ? ' – ' + fmtShort(T.trip.end_date) : '')) : '';
    var tabs = [['balances', 'Balances'], ['expenses', 'Expenses'], ['itinerary', 'Itinerary'], ['people', 'People'], ['settings', 'Settings']];
    var body = { balances: viewBalances, expenses: viewExpenses, itinerary: viewItinerary, people: viewPeople, settings: viewSettings }[tab](c);
    $('#app').innerHTML =
      '<header class="top"><div class="topline"><button class="iconbtn" data-act="home">‹ Trips</button>' +
      '<div class="grow"><h1>' + esc(T.trip.name) + '</h1>' + (dates ? '<p>' + esc(dates) + '</p>' : '') + '</div>' +
      '<button class="iconbtn" data-act="share">Share link</button></div>' +
      '<div class="stats"><div><span>Total spent</span><b>' + money(c.total) + '</b></div>' +
      '<div><span>People</span><b>' + T.people.length + '</b></div></div></header>' +
      '<nav class="tabs">' + tabs.map(function (t) {
        return '<button data-act="tab" data-tab="' + t[0] + '"' + (t[0] === tab ? ' class="on"' : '') + '>' + t[1] + '</button>';
      }).join('') + '</nav><main>' + body + '</main>';
    window.scrollTo(0, sy);
  }

  function viewBalances(c) {
    if (!T.people.length) return '<div class="card"><div class="empty">Add people in the People tab first.</div></div>';
    var anySettled = T.expenses.some(function (e) { return e.kind === 'payment'; });
    var rows = T.people.map(function (p) {
      var r = c.per[p.id], cls = r.net > 0 ? 'pos' : (r.net < 0 ? 'neg' : '');
      var label = r.net > 0 ? 'Gets ' + money(r.net) : (r.net < 0 ? 'Owes ' + money(-r.net) : 'Settled');
      return '<tr><td>' + esc(p.name) + '</td><td class="num">' + money(r.paid) + '</td><td class="num">' + money(r.share) + '</td>' +
        (anySettled ? '<td class="num">' + money(r.settled) + '</td>' : '') + '<td class="num ' + cls + '">' + label + '</td></tr>';
    }).join('');
    var pays = settle(c.per);
    var payHtml = pays.length ? pays.map(function (p) {
      return '<div class="pay"><span><b>' + esc(pname(p.from)) + '</b> pays <b>' + esc(pname(p.to)) + '</b></span>' +
        '<span class="amt">' + money(p.amt) + '</span>' +
        '<button class="btn ghost small" data-act="settleUp" data-from="' + esc(p.from) + '" data-to="' + esc(p.to) + '" data-amt="' + p.amt + '">Mark as paid</button></div>';
    }).join('') : '<div class="empty">' + (T.expenses.length ? 'Everyone is settled up.' : 'No expenses yet.') + '</div>';
    var cats = Object.keys(c.byCat).sort(function (a, b) { return c.byCat[b] - c.byCat[a]; });
    var catHtml = cats.length ? '<div class="card"><h2>Spending by category</h2><table><tbody>' + cats.map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td class="num">' + money(c.byCat[k]) + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '';
    return '<div class="card"><h2>Who is owed and who owes</h2><p class="hint">Paid = what they paid out of pocket. Share = their part of all bills.</p>' +
      '<table><thead><tr><th>Person</th><th class="num">Paid</th><th class="num">Share</th>' + (anySettled ? '<th class="num">Settled</th>' : '') + '<th class="num">Balance</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="card"><h2>Who pays whom</h2><p class="hint">The fewest payments that settle everything. Tap "Mark as paid" after the money is sent.</p>' + payHtml +
      '<div class="btnrow"><button class="btn ghost" data-act="copySummary">Copy summary for WhatsApp</button></div></div>' + catHtml;
  }

  function viewExpenses() {
    var head = '<div class="btnrow" style="margin:0 0 14px"><button class="btn" data-act="addExpense">+ Add expense</button></div>';
    if (!T.expenses.length) return head + '<div class="card"><div class="empty">No expenses yet.</div></div>';
    return head + '<div class="card">' + T.expenses.map(function (e) {
      var n = (e.split_between || []).length, who = n === T.people.length ? 'everyone' : n + ' of ' + T.people.length;
      var main, meta;
      if (e.kind === 'payment') {
        main = '<span class="tag">Payment</span> ' + esc(pname(e.paid_by)) + ' paid ' + esc(pname((e.split_between || [])[0]));
        meta = esc(e.spent_on);
      } else {
        main = esc(e.description);
        meta = esc(e.spent_on) + ' · ' + esc(e.category) + ' · paid by ' + esc(pname(e.paid_by)) + ' · split with ' + who;
      }
      return '<div class="item"><div><div><b>' + main + '</b></div><div class="meta">' + meta + '</div>' +
        '<div class="acts">' + (e.kind === 'payment' ? '' : '<button class="btn ghost small" data-act="editExpense" data-id="' + esc(e.id) + '">Edit</button>') +
        '<button class="btn danger small" data-act="delExpense" data-id="' + esc(e.id) + '">Delete</button></div></div>' +
        '<div class="amt">' + money(cents(e.amount)) + '</div></div>';
    }).join('') + '</div>';
  }

  function viewItinerary() {
    var head = '<div class="btnrow" style="margin:0 0 14px"><button class="btn" data-act="addItem">+ Add plan</button></div>';
    if (!T.itinerary.length) return head + '<div class="card"><div class="empty">No plans yet. Add places, timings and notes.</div></div>';
    var html = '', cur = null;
    T.itinerary.forEach(function (i) {
      if (i.day !== cur) { cur = i.day; html += '<div class="day">' + esc(fmtDay(i.day)) + '</div>'; }
      html += '<div class="item"><div><div><b>' + (i.start_time ? esc(i.start_time) + ' · ' : '') + esc(i.title) + '</b></div>' +
        (i.notes ? '<div class="meta">' + esc(i.notes) + '</div>' : '') +
        '<div class="acts"><button class="btn ghost small" data-act="editItem" data-id="' + esc(i.id) + '">Edit</button>' +
        '<button class="btn danger small" data-act="delItem" data-id="' + esc(i.id) + '">Delete</button></div></div></div>';
    });
    return head + '<div class="card">' + html + '</div>';
  }

  function viewPeople() {
    var rows = T.people.map(function (p) {
      return '<form class="pr" data-form="renamePerson" data-id="' + esc(p.id) + '"><input name="name" maxlength="60" value="' + esc(p.name) + '" required>' +
        '<button class="btn ghost small" type="submit">Save</button>' +
        '<button class="btn danger small" type="button" data-act="removePerson" data-id="' + esc(p.id) + '">Remove</button></form>';
    }).join('');
    return '<div class="card"><h2>People on this trip</h2>' + (rows || '<div class="empty">Nobody yet.</div>') + '</div>' +
      '<div class="card"><h2>Add a person</h2><form data-form="addPerson" class="pr"><input name="name" maxlength="60" placeholder="Name" required>' +
      '<button class="btn" type="submit">Add</button></form></div>';
  }

  function viewSettings() {
    var t = T.trip, curs = ['₹', '$', '€', '£', '¥'];
    return '<div class="card"><h2>Share this trip</h2><p class="hint">Anyone with this link can view and edit the trip. Send it only to people in your group.</p>' +
      '<div class="sharebox">' + esc(shareLink()) + '</div><div class="btnrow"><button class="btn" data-act="share">Copy link</button></div></div>' +
      '<div class="card"><h2>Trip details</h2><form data-form="saveTrip"><label>Trip name</label><input name="name" maxlength="80" value="' + esc(t.name) + '" required>' +
      '<div class="row"><div><label>Currency</label><select name="currency">' + curs.map(function (c) { return '<option' + (c === t.currency ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Start date</label><input type="date" name="start" value="' + esc(t.start_date || '') + '"></div>' +
      '<div><label>End date</label><input type="date" name="end" value="' + esc(t.end_date || '') + '"></div></div>' +
      '<div class="btnrow"><button class="btn" type="submit">Save</button></div></form></div>' +
      '<div class="card"><h2>Danger zone</h2><p class="hint">Deleting removes the trip, people, expenses and itinerary for everyone, permanently.</p>' +
      '<div class="btnrow"><button class="btn danger" data-act="deleteTrip">Delete this trip</button></div></div>';
  }

  // ------------------------------------------------------------------ modals
  function openModal(html) { $('#modalRoot').innerHTML = '<div class="overlay"><div class="modal">' + html + '</div></div>'; }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function modalOpen() { return !!$('#modalRoot').firstChild; }

  function expenseModal(e) {
    if (!T.people.length) { toast('Add people first'); tab = 'people'; renderTrip(); return; }
    e = e || { description: '', amount: '', paid_by: T.people[0].id, split_between: T.people.map(function (p) { return p.id; }), category: 'Food & Drinks', spent_on: todayStr() };
    openModal('<h2>' + (e.id ? 'Edit expense' : 'Add expense') + '</h2>' +
      '<form data-form="expense" data-id="' + esc(e.id || '') + '">' +
      '<label>What was it for?</label><input name="description" maxlength="120" value="' + esc(e.description) + '" placeholder="e.g. Dinner" required>' +
      '<div class="row"><div><label>Amount</label><input name="amount" type="number" inputmode="decimal" min="0.01" step="0.01" value="' + esc(e.amount) + '" required></div>' +
      '<div><label>Date</label><input name="date" type="date" value="' + esc(e.spent_on) + '" required></div></div>' +
      '<div class="row"><div><label>Category</label><select name="category">' + CATS.map(function (c) { return '<option' + (c === e.category ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>' +
      '<div><label>Who paid?</label><select name="paid_by">' + T.people.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === e.paid_by ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('') + '</select></div></div>' +
      '<label>Split between (tick everyone who shares this bill)</label><div class="checks">' +
      T.people.map(function (p) { return '<label><input type="checkbox" class="sp" value="' + esc(p.id) + '"' + (e.split_between.indexOf(p.id) >= 0 ? ' checked' : '') + '> ' + esc(p.name) + '</label>'; }).join('') + '</div>' +
      '<div class="btnrow" style="margin-top:8px"><button type="button" class="btn ghost small" data-act="selAll">Everyone</button><button type="button" class="btn ghost small" data-act="selNone">Clear</button></div>' +
      '<div class="result" id="splitPreview" style="display:none"></div>' +
      '<div class="btnrow"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div></form>');
    updateSplitPreview();
  }
  function updateSplitPreview() {
    var f = $('#modalRoot form'); if (!f || f.getAttribute('data-form') !== 'expense') return;
    var amt = parseFloat(f.elements.amount.value), n = f.querySelectorAll('.sp:checked').length, box = $('#splitPreview');
    if (amt > 0 && n) { box.style.display = 'block'; box.textContent = 'Each of the ' + n + ' people shares ' + money(Math.round(amt * 100 / n)); }
    else box.style.display = 'none';
  }
  function itemModal(i) {
    i = i || { day: T.trip.start_date || todayStr(), start_time: '', title: '', notes: '' };
    openModal('<h2>' + (i.id ? 'Edit plan' : 'Add plan') + '</h2><form data-form="item" data-id="' + esc(i.id || '') + '">' +
      '<div class="row"><div><label>Day</label><input name="day" type="date" value="' + esc(i.day) + '" required></div>' +
      '<div><label>Time (optional)</label><input name="time" type="time" value="' + esc(i.start_time || '') + '"></div></div>' +
      '<label>What are we doing?</label><input name="title" maxlength="120" value="' + esc(i.title) + '" placeholder="e.g. Sunset at Table Land" required>' +
      '<label>Notes (optional)</label><textarea name="notes" maxlength="1000" placeholder="Address, booking number, tips...">' + esc(i.notes || '') + '</textarea>' +
      '<div class="btnrow"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" data-act="closeModal">Cancel</button></div></form>');
  }

  // ------------------------------------------------------------------ data flow
  function showError(msg, showHome) {
    $('#app').innerHTML = '<header class="top"><h1>Trip Splitter</h1></header><main><div class="card"><h2>Oops</h2><p>' + esc(msg) + '</p>' +
      '<div class="btnrow"><button class="btn" data-act="retry">Try again</button><button class="btn ghost" data-act="home">Back to trips</button></div></div></main>';
  }
  function load(silent) {
    return rpc('get_trip', { p_code: code }).then(function (data) {
      var j = JSON.stringify(data);
      var changed = j !== lastJson;
      lastJson = j; T = data;
      rememberTrip(code, T.trip.name);
      if (changed || !silent) {
        var ae = document.activeElement;
        if (silent && ae && /INPUT|TEXTAREA|SELECT/.test(ae.tagName)) return;
        renderTrip();
      }
    });
  }
  function openTrip(c) {
    code = c; T = null; lastJson = '';
    $('#app').innerHTML = '<div class="center">Loading trip…</div>';
    load(false).then(startPoll, function (e) { stopPoll(); showError(e.message); });
  }
  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      if (!code || busy || modalOpen() || document.hidden) return;
      load(true).catch(function () {});
    }, 15000);
  }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function route() {
    closeModal();
    if (!cfg) return renderSetup();
    var m = location.hash.match(/^#\/t\/([0-9a-fA-F]{32})/);
    if (m) openTrip(m[1].toLowerCase());
    else { T = null; code = null; stopPoll(); renderHome(); }
  }
  // run a write, then refresh
  function write(promise, okMsg, keepModalOnError) {
    if (busy) return Promise.resolve();
    busy = true;
    return promise.then(function () {
      closeModal(); if (okMsg) toast(okMsg);
      return load(false);
    }).catch(function (e) { toast(e.message); }).then(function () { busy = false; });
  }

  // ------------------------------------------------------------------ events
  var ACT = {
    home: function () { location.hash = '#/'; },
    retry: function () { route(); },
    openTrip: function (d) { location.hash = '#/t/' + d.code; },
    forgetTrip: function (d) { forgetTrip(d.code); renderHome(); },
    tab: function (d) { tab = d.tab; renderTrip(); window.scrollTo(0, 0); },
    share: function () { copyText(shareLink(), 'Trip link copied. Send it to your group.'); },
    closeModal: closeModal,
    selAll: function () { document.querySelectorAll('.sp').forEach(function (b) { b.checked = true; }); updateSplitPreview(); },
    selNone: function () { document.querySelectorAll('.sp').forEach(function (b) { b.checked = false; }); updateSplitPreview(); },
    addExpense: function () { expenseModal(); },
    editExpense: function (d) {
      var e = T.expenses.filter(function (x) { return x.id === d.id; })[0];
      if (e) expenseModal({ id: e.id, description: e.description, amount: e.amount, paid_by: e.paid_by, split_between: e.split_between, category: e.category, spent_on: e.spent_on });
    },
    delExpense: function (d) {
      if (confirm('Delete this entry?')) write(rpc('delete_expense', { p_code: code, p_id: d.id }), 'Deleted');
    },
    addItem: function () { itemModal(); },
    editItem: function (d) {
      var i = T.itinerary.filter(function (x) { return x.id === d.id; })[0];
      if (i) itemModal(i);
    },
    delItem: function (d) {
      if (confirm('Delete this plan?')) write(rpc('delete_itinerary', { p_code: code, p_id: d.id }), 'Deleted');
    },
    removePerson: function (d) {
      if (confirm('Remove ' + pname(d.id) + ' from this trip?')) write(rpc('remove_person', { p_code: code, p_person: d.id }), 'Person removed');
    },
    settleUp: function (d) {
      var amt = Number(d.amt) / 100;
      if (!confirm(pname(d.from) + ' paid ' + pname(d.to) + ' ' + money(Number(d.amt)) + '?')) return;
      write(rpc('save_expense', { p_code: code, p_id: null, p_description: 'Payment: ' + pname(d.from) + ' to ' + pname(d.to),
        p_amount: amt, p_paid_by: d.from, p_split: [d.to], p_category: 'Settlement', p_date: todayStr(), p_kind: 'payment' }), 'Payment recorded');
    },
    deleteTrip: function () {
      if (!confirm('Delete this whole trip for everyone? This cannot be undone.')) return;
      if (busy) return; busy = true;
      rpc('delete_trip', { p_code: code }).then(function () {
        forgetTrip(code); toast('Trip deleted'); busy = false; location.hash = '#/';
      }, function (e) { busy = false; toast(e.message); });
    },
    copySummary: function () {
      var c = compute(T), pays = settle(c.per);
      var L = ['*' + T.trip.name + ' - Settlement*', 'Total spent: ' + money(c.total), ''];
      T.people.forEach(function (p) {
        var r = c.per[p.id];
        L.push(p.name + ': paid ' + money(r.paid) + ', share ' + money(r.share) + ' -> ' + (r.net > 0 ? 'gets ' + money(r.net) : (r.net < 0 ? 'owes ' + money(-r.net) : 'settled')));
      });
      L.push('');
      if (pays.length) { L.push('*Who pays whom*'); pays.forEach(function (p) { L.push(pname(p.from) + ' pays ' + pname(p.to) + ' ' + money(p.amt)); }); }
      else L.push('Everyone is settled up.');
      copyText(L.join('\n'), 'Summary copied');
    }
  };
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest('[data-act]'); if (!el) return;
    if (el.getAttribute('data-act') === 'openTrip' && ev.target.closest('[data-act="forgetTrip"]')) el = ev.target.closest('[data-act="forgetTrip"]');
    var fn = ACT[el.getAttribute('data-act')];
    if (fn) { ev.preventDefault(); fn(el.dataset, ev); }
  });
  document.addEventListener('input', function () { updateSplitPreview(); });
  document.addEventListener('change', function () { updateSplitPreview(); });

  var FORMS = {
    setup: function (f) {
      var url = f.elements.url.value.trim(), key = f.elements.key.value.trim();
      if (!/^https:\/\//i.test(url)) { toast('The URL must start with https://'); return; }
      LS.set('ts_cfg', { url: url, key: key }); cfg = getCfg(); route();
    },
    createTrip: function (f) {
      var people = f.elements.people.value.split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      var btn = f.querySelector('button[type=submit]'); btn.disabled = true;
      rpc('create_trip', { p_name: f.elements.name.value.trim(), p_currency: f.elements.currency.value,
        p_start: f.elements.start.value || null, p_end: f.elements.end.value || null, p_people: people })
        .then(function (c) { rememberTrip(c, f.elements.name.value.trim()); location.hash = '#/t/' + c; },
          function (e) { btn.disabled = false; toast(e.message); });
    },
    joinTrip: function (f) {
      var m = f.elements.link.value.match(/[0-9a-fA-F]{32}/);
      if (!m) { toast('That does not look like a trip link'); return; }
      location.hash = '#/t/' + m[0].toLowerCase();
    },
    expense: function (f) {
      var ids = Array.prototype.map.call(f.querySelectorAll('.sp:checked'), function (b) { return b.value; });
      var amt = parseFloat(f.elements.amount.value);
      if (!(amt > 0)) { toast('Enter an amount greater than 0'); return; }
      if (!ids.length) { toast('Tick at least one person to split with'); return; }
      write(rpc('save_expense', { p_code: code, p_id: f.getAttribute('data-id') || null, p_description: f.elements.description.value.trim(),
        p_amount: Math.round(amt * 100) / 100, p_paid_by: f.elements.paid_by.value, p_split: ids, p_category: f.elements.category.value,
        p_date: f.elements.date.value || todayStr(), p_kind: 'expense' }), 'Saved');
    },
    item: function (f) {
      write(rpc('save_itinerary', { p_code: code, p_id: f.getAttribute('data-id') || null, p_day: f.elements.day.value,
        p_time: f.elements.time.value || null, p_title: f.elements.title.value.trim(), p_notes: f.elements.notes.value.trim() || null }), 'Saved');
    },
    addPerson: function (f) {
      var n = f.elements.name.value.trim(); if (!n) return;
      write(rpc('add_person', { p_code: code, p_name: n }), 'Person added');
    },
    renamePerson: function (f) {
      write(rpc('rename_person', { p_code: code, p_person: f.getAttribute('data-id'), p_name: f.elements.name.value.trim() }), 'Saved');
    },
    saveTrip: function (f) {
      write(rpc('update_trip', { p_code: code, p_name: f.elements.name.value.trim(), p_currency: f.elements.currency.value,
        p_start: f.elements.start.value || null, p_end: f.elements.end.value || null }), 'Saved');
    }
  };
  document.addEventListener('submit', function (ev) {
    var f = ev.target; var name = f.getAttribute && f.getAttribute('data-form'); if (!name) return;
    ev.preventDefault();
    if (FORMS[name]) FORMS[name](f);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && code && !busy && !modalOpen()) load(true).catch(function () {});
  });

  // expose pure helpers for tests
  window.__TS = { compute: compute, settle: settle, cents: cents };

  cfg = getCfg();
  route();
})();

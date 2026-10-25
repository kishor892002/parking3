/* ParkEase – Vehicle Parking Management
 * Plain JavaScript, no dependencies. Data is stored in localStorage.
 */
(() => {
  'use strict';

  /* ---------- Configuration ---------- */
  const STORAGE_KEY = 'parkease_v1';

  const RATES = { bike: 15, car: 30, large: 60 }; // ₹ per started hour

  // Where payments go. The check-out QR is built from these details, with the
  // bill amount filled in. Change them to receive money in a different account.
  const UPI = { id: '7754084726-4@ibl', name: 'RAJ MAURYA' };

  // Online payments (optional). When the ParkEase server is running (see README),
  // the QR comes from the payment gateway and check-out completes by itself once
  // the money arrives. Without the server, the manual flow below is used.
  const API_BASE = (window.PARKEASE_API || '').replace(/\/$/, '');
  let payApi = null; // becomes { mode } when the server is detected
  const TYPE_LABEL = { bike: 'Bike', car: 'Car', large: 'Truck / Van' };

  const ZONES = [
    { id: 'A', type: 'bike',  label: 'Bike zone',          count: 8 },
    { id: 'B', type: 'car',   label: 'Car zone',           count: 12 },
    { id: 'C', type: 'large', label: 'Truck / Van zone',   count: 4 }
  ];

  const SLOTS = ZONES.flatMap(zone =>
    Array.from({ length: zone.count }, (_, i) => ({ code: `${zone.id}${i + 1}`, type: zone.type }))
  );

  /* ---------- Helpers ---------- */
  const $ = id => document.getElementById(id);

  const esc = value =>
    String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const money = n => '₹' + Number(n).toLocaleString('en-IN');

  const fmtDateTime = ts =>
    new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

  function fmtDuration(ms) {
    const totalMin = Math.max(0, Math.floor(ms / 60000));
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  // Charged per started hour, minimum one hour.
  function calcFee(entry, exit, type) {
    const hours = Math.max(1, Math.ceil((exit - entry) / 3600000));
    return hours * RATES[type];
  }

  const makeId = () =>
    (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);

  /* ---------- State ---------- */
  let state = loadState();
  let selectedSlot = null;

  function loadState() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (raw && Array.isArray(raw.parked) && Array.isArray(raw.history)) return raw;
    } catch (e) { /* ignore corrupt or unavailable storage */ }
    return { parked: [], history: [] };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save data in this browser.');
    }
  }

  const findBySlot = code => state.parked.find(v => v.slot === code);

  /* ---------- Rendering ---------- */
  function renderStats() {
    const occupied = state.parked.length;
    const today = new Date().toDateString();
    const revenue = state.history
      .filter(h => new Date(h.exit).toDateString() === today)
      .reduce((sum, h) => sum + h.fee, 0);

    $('statTotal').textContent = SLOTS.length;
    $('statOccupied').textContent = occupied;
    $('statFree').textContent = SLOTS.length - occupied;
    $('statRevenue').textContent = money(revenue);
  }

  function renderSlotSelect() {
    const type = $('type').value;
    const select = $('slot');
    const free = SLOTS.filter(s => s.type === type && !findBySlot(s.code));

    if (!free.length) {
      select.innerHTML = '<option value="">No slots available</option>';
      select.disabled = true;
      return;
    }

    select.disabled = false;
    select.innerHTML = free.map(s => `<option value="${s.code}">${s.code}</option>`).join('');
    if (selectedSlot && free.some(s => s.code === selectedSlot)) select.value = selectedSlot;
  }

  function renderSlotGrid() {
    $('slotGrid').innerHTML = ZONES.map(zone => {
      const buttons = SLOTS.filter(s => s.type === zone.type).map(s => {
        const vehicle = findBySlot(s.code);
        const cls = vehicle ? 'slot-occupied' : 'slot-free';
        const sel = s.code === selectedSlot && !vehicle ? ' slot-selected' : '';
        const label = vehicle ? `${s.code}, occupied by ${vehicle.plate}` : `${s.code}, available`;
        return `<button type="button" class="slot ${cls}${sel}" data-code="${s.code}" aria-label="${esc(label)}" title="${esc(label)}">
                  ${s.code}${vehicle ? `<small>${esc(vehicle.plate)}</small>` : ''}
                </button>`;
      }).join('');
      return `<div class="zone">
                <h3><span>${zone.label}</span><span>${money(RATES[zone.type])} / hr</span></h3>
                <div class="slots">${buttons}</div>
              </div>`;
    }).join('');
  }

  function renderParked() {
    const query = $('search').value.trim().toLowerCase();
    const now = Date.now();

    const rows = state.parked
      .filter(v => !query || [v.plate, v.owner, v.slot].some(f => f.toLowerCase().includes(query)))
      .sort((a, b) => b.entry - a.entry);

    $('parkedBody').innerHTML = rows.length
      ? rows.map(v => `
          <tr>
            <td><span class="plate-tag">${esc(v.plate)}</span></td>
            <td><span class="badge">${TYPE_LABEL[v.type]}</span></td>
            <td>${esc(v.owner)}${v.phone ? `<br><small>${esc(v.phone)}</small>` : ''}</td>
            <td><strong>${v.slot}</strong></td>
            <td>${fmtDateTime(v.entry)}</td>
            <td>${fmtDuration(now - v.entry)}</td>
            <td>${money(calcFee(v.entry, now, v.type))}</td>
            <td><button class="btn btn-small btn-checkout" data-checkout="${v.id}">Check out</button></td>
          </tr>`).join('')
      : `<tr><td colspan="8" class="empty">${query ? 'No vehicles match your search.' : 'No vehicles are parked right now.'}</td></tr>`;
  }

  function renderHistory() {
    const rows = [...state.history].sort((a, b) => b.exit - a.exit);

    $('historyBody').innerHTML = rows.length
      ? rows.map(h => `
          <tr>
            <td><span class="plate-tag">${esc(h.plate)}</span></td>
            <td><span class="badge">${TYPE_LABEL[h.type]}</span></td>
            <td>${esc(h.owner)}</td>
            <td>${h.slot}</td>
            <td>${fmtDateTime(h.entry)}</td>
            <td>${fmtDateTime(h.exit)}</td>
            <td>${fmtDuration(h.exit - h.entry)}</td>
            <td><strong>${money(h.fee)}</strong></td>
          </tr>`).join('')
      : '<tr><td colspan="8" class="empty">No completed parking sessions yet.</td></tr>';
  }

  function renderAll() {
    renderStats();
    renderSlotSelect();
    renderSlotGrid();
    renderParked();
    renderHistory();
  }

  /* ---------- Toast & modal ---------- */
  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function openModal(title, bodyHtml, actions) {
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = bodyHtml;
    const box = $('modalActions');
    box.innerHTML = '';
    actions.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `btn ${a.cls || 'btn-ghost'}`;
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      box.appendChild(btn);
    });
    $('modal').hidden = false;
    // Focus the main button if there is one, otherwise the first (safest) button.
    const target = box.querySelector('.btn-primary') || box.firstElementChild;
    if (target) target.focus();
  }

  let checkoutToken = 0; // changes whenever a check-out window opens or closes
  let payPoll = null;    // timer while waiting for an online payment
  let payJob = null;     // gateway payment currently on screen, e.g. { id }

  function stopPolling() { clearInterval(payPoll); payPoll = null; }

  // Stop waiting for a payment and close its QR (used when the window closes unpaid).
  function abandonPayment() {
    stopPolling();
    if (payJob) {
      const id = payJob.id;
      payJob = null;
      api('POST', `/api/payments/${id}/cancel`).catch(() => {});
    }
  }

  function closeModal() {
    checkoutToken++;
    abandonPayment();
    $('modal').hidden = true;
  }

  const receiptHtml = (v, exit, fee, final) => `
    <ul class="receipt">
      <li><span>Vehicle</span><span>${esc(v.plate)}</span></li>
      <li><span>Type</span><span>${TYPE_LABEL[v.type]}</span></li>
      <li><span>Owner</span><span>${esc(v.owner)}</span></li>
      <li><span>Slot</span><span>${v.slot}</span></li>
      <li><span>Entry</span><span>${fmtDateTime(v.entry)}</span></li>
      <li><span>${final ? 'Exit' : 'Now'}</span><span>${fmtDateTime(exit)}</span></li>
      <li><span>Duration</span><span>${fmtDuration(exit - v.entry)}</span></li>
      <li><span>Rate</span><span>${money(RATES[v.type])} / hr</span></li>
      <li class="total"><span>${final ? 'Amount paid' : 'Amount due'}</span><span>${money(fee)}</span></li>
    </ul>`;

  /* ---------- Actions ---------- */
  // Builds a UPI payment QR for this exact bill, so the amount is filled in
  // automatically when the customer scans it. Returns null if it can't be built.
  function safeEncode(text) {
    try { return QRCode.encode(text); } catch (e) { return null; }
  }

  function makeQr(v, fee) {
    return safeEncode(`upi://pay?pa=${UPI.id}&pn=${encodeURIComponent(UPI.name)}` +
                      `&am=${fee}.00&cu=INR&tn=${encodeURIComponent('Parking ' + v.plate)}`);
  }

  // Talks to the ParkEase server (JSON in, JSON out).
  async function api(method, path, body) {
    const res = await fetch(API_BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  // Detect the payment server once at start-up. On GitHub Pages or a plain file
  // there is no server, so the site simply stays in manual mode.
  // If the server simply wasn't reachable yet (e.g. started after the page was
  // opened), detection is retried every 30 seconds until it answers.
  let retryDetect = false;
  function detectServer() {
    if (!/^https?:$/.test(location.protocol)) return;
    fetch(API_BASE + '/api/health', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(h => {
        retryDetect = false;
        if (h && h.ok && (h.mode === 'razorpay' || h.mode === 'mock')) {
          payApi = { mode: h.mode };
          const badge = $('payBadge');
          badge.textContent = h.mode === 'mock' ? 'Auto-pay: demo mode' : 'Auto-pay: on';
          badge.hidden = false;
        }
      })
      .catch(() => { retryDetect = true; }); // no server reachable – manual mode for now
  }

  // Payment QR shown to the customer at check-out.
  function qrBlock(qr, fee) {
    if (qr) {
      return `
        <div class="pay">
          <div class="pay-qr">${QRCode.toSvg(qr)}</div>
          <p class="pay-title">Scan to pay <strong>${money(fee)}</strong></p>
          <p class="pay-note">The amount is filled in automatically in PhonePe or any UPI app.</p>
        </div>`;
    }
    // Fallback: your original static QR (customer must type the amount).
    return window.PAYMENT_QR ? `
      <div class="pay">
        <img class="pay-qr" src="${window.PAYMENT_QR.data}" alt="Payment QR code">
        <p class="pay-title">Scan to pay <strong>${money(fee)}</strong></p>
        <p class="pay-note">Enter the amount shown when paying.</p>
      </div>` : '';
  }

  const fmtPdfDate = ts =>
    new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // One PDF containing the bill details and (for an unpaid bill) the payment QR.
  function downloadPdf(v, exit, fee, final, qr) {
    ParkPdf.download({
      title: final ? 'Payment Receipt' : 'Parking Bill',
      rows: [
        ['Vehicle', v.plate],
        ['Type', TYPE_LABEL[v.type]],
        ['Owner', v.owner],
        ['Slot', v.slot],
        ['Entry', fmtPdfDate(v.entry)],
        [final ? 'Exit' : 'Bill time', fmtPdfDate(exit)],
        ['Duration', fmtDuration(exit - v.entry)],
        ['Rate', `Rs. ${RATES[v.type]} / hour`]
      ],
      totalLabel: final ? 'Amount paid' : 'Amount due',
      total: `Rs. ${fee.toLocaleString('en-IN')}`,
      paid: final,
      qrMatrix: final ? null : qr,
      qr: final || qr ? null : (window.PAYMENT_QR || null),
      qrCaption: `Scan to pay Rs. ${fee.toLocaleString('en-IN')}`,
      qrNote: qr ? 'The amount is filled in automatically in PhonePe or any UPI app.'
                 : 'Use PhonePe or any UPI app and enter the amount shown above.'
    }, `ParkEase-${final ? 'receipt' : 'bill'}-${v.plate}.pdf`);
  }

  function openCheckout(id) {
    const v = state.parked.find(x => x.id === id);
    if (!v) return;
    const exit = Date.now(); // fixed now, so the bill, QR amount and final receipt all match
    const fee = calcFee(v.entry, exit, v.type);
    checkoutToken++;
    abandonPayment(); // in case an earlier payment was still being waited on
    if (payApi) openOnlineCheckout(v, exit, fee);
    else openManualCheckout(v, exit, fee);
  }

  // Manual flow: show the QR; the cashier taps "Payment received" after seeing the payment.
  function openManualCheckout(v, exit, fee) {
    const qr = makeQr(v, fee);
    openModal('Check out & pay', receiptHtml(v, exit, fee, false) + qrBlock(qr, fee), [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Download bill (PDF)', onClick: () => downloadPdf(v, exit, fee, false, qr) },
      { label: 'Payment received', cls: 'btn-primary', onClick: () => completeCheckout(v.id, exit) }
    ]);
  }

  // Automatic flow: the server creates the QR, then we wait until it is paid and
  // check the vehicle out without anyone pressing a button.
  async function openOnlineCheckout(v, exit, fee) {
    const token = checkoutToken;
    openModal('Check out & pay',
      receiptHtml(v, exit, fee, false) + '<div class="pay"><p class="pay-title">Creating payment QR…</p></div>',
      [{ label: 'Cancel', onClick: closeModal }]);

    let job;
    try {
      job = await api('POST', '/api/payments', { amount: fee, plate: v.plate, slot: v.slot });
    } catch (e) {
      if (token !== checkoutToken) return;
      toast('Auto-payment is unavailable right now. Showing the manual QR.');
      return openManualCheckout(v, exit, fee);
    }
    if (token !== checkoutToken) { // window was closed while the QR was being made
      api('POST', `/api/payments/${job.id}/cancel`).catch(() => {});
      return;
    }

    payJob = { id: job.id };
    const qr = job.upiLink ? safeEncode(job.upiLink) : null;
    const qrHtml = qr ? QRCode.toSvg(qr)
      : (/^https:\/\//.test(job.imageUrl || '') ? `<img src="${esc(job.imageUrl)}" alt="Payment QR code">` : '');

    const actions = [{ label: 'Cancel', onClick: closeModal }];
    if (qr) actions.push({ label: 'Download bill (PDF)', onClick: () => downloadPdf(v, exit, fee, false, qr) });
    if (job.mode === 'mock') {
      actions.push({
        label: 'Simulate payment (demo)', cls: 'btn-primary',
        onClick: () => api('POST', `/api/mock/pay/${job.id}`).catch(err => toast(err.message))
      });
    }
    actions.push({ label: 'Mark paid manually', onClick: () => completeCheckout(v.id, exit) });

    openModal('Scan to pay', receiptHtml(v, exit, fee, false) + `
      <div class="pay">
        <div class="pay-qr">${qrHtml}</div>
        <p class="pay-title">Scan to pay <strong>${money(fee)}</strong></p>
        <p id="payStatus" class="pay-note pay-wait">Waiting for payment…</p>
      </div>`, actions);

    let failures = 0;
    payPoll = setInterval(async () => {
      let status;
      try {
        status = await api('GET', `/api/payments/${job.id}`);
        failures = 0;
      } catch (e) {
        if (++failures === 4 && token === checkoutToken && $('payStatus')) {
          $('payStatus').textContent = 'Cannot reach the server. Check the connection, or mark as paid manually.';
        }
        return;
      }
      if (token !== checkoutToken || !payPoll) return; // window closed, or already handled
      if (status.status === 'paid') {
        stopPolling();
        payJob = null;
        completeCheckout(v.id, exit, { auto: true, paymentId: status.paymentId });
      } else if (status.status === 'closed') {
        stopPolling();
        payJob = null;
        if ($('payStatus')) $('payStatus').textContent = 'This QR has expired. Close this window and try again.';
      }
    }, 2500);
  }

  function completeCheckout(id, exitTime, opts) {
    const idx = state.parked.findIndex(x => x.id === id);
    if (idx === -1) return;
    abandonPayment(); // if a QR is still open (manual override), close it

    const v = state.parked[idx];
    const exit = exitTime || Date.now();
    const fee = calcFee(v.entry, exit, v.type);
    const auto = !!(opts && opts.auto);

    state.parked.splice(idx, 1);
    state.history.push({ ...v, exit, fee, paidVia: auto ? 'auto' : 'manual', paymentId: (opts && opts.paymentId) || null });
    saveState();
    renderAll();

    const banner = auto ? `
      <div class="pay-success" role="status">
        <span class="tick" aria-hidden="true">✓</span>
        <div><strong>${money(fee)} received</strong><br>${esc(v.plate)} has been checked out automatically.</div>
      </div>` : '';

    openModal(auto ? 'Payment successful' : 'Receipt', banner + receiptHtml(v, exit, fee, true), [
      { label: 'Print', onClick: () => window.print() },
      { label: 'Download receipt (PDF)', onClick: () => downloadPdf(v, exit, fee, true) },
      { label: 'Done', cls: 'btn-primary', onClick: closeModal }
    ]);
  }

  function showFormError(message) {
    const el = $('formError');
    el.textContent = message;
    el.hidden = !message;
  }

  function handleEntry(event) {
    event.preventDefault();

    const plate = $('plate').value.toUpperCase().replace(/[\s-]/g, '');
    const type = $('type').value;
    const owner = $('owner').value.trim();
    const phone = $('phone').value.trim();
    const slot = $('slot').value;

    if (!/^[A-Z0-9]{4,12}$/.test(plate)) return showFormError('Enter a valid vehicle number (4–12 letters or digits).');
    if (owner.length < 2) return showFormError('Please enter the owner name.');
    if (phone && !/^\d{10}$/.test(phone)) return showFormError('Phone number must be 10 digits.');
    if (!slot) return showFormError('No free slot for this vehicle type.');
    if (state.parked.some(v => v.plate === plate)) return showFormError(`${plate} is already parked.`);
    if (findBySlot(slot)) return showFormError(`Slot ${slot} is already taken.`);

    showFormError('');
    state.parked.push({ id: makeId(), plate, type, owner, phone, slot, entry: Date.now() });
    saveState();

    selectedSlot = null;
    $('entryForm').reset();
    $('type').value = type; // keep last used type for quick entry
    renderAll();
    toast(`${plate} parked in slot ${slot}.`);
    $('plate').focus();
  }

  function handleSlotClick(event) {
    const btn = event.target.closest('.slot');
    if (!btn) return;

    const code = btn.dataset.code;
    const vehicle = findBySlot(code);
    if (vehicle) return openCheckout(vehicle.id);

    selectedSlot = code;
    $('type').value = SLOTS.find(s => s.code === code).type;
    renderSlotSelect();
    $('slot').value = code;
    renderSlotGrid();
    $('plate').focus();
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(tab => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    $('panel-parked').hidden = name !== 'parked';
    $('panel-history').hidden = name !== 'history';
  }

  function exportCsv() {
    if (!state.history.length) return toast('No history to export yet.');

    const header = ['Vehicle', 'Type', 'Owner', 'Phone', 'Slot', 'Entry', 'Exit', 'Duration', 'Fee (INR)'];
    const cell = v => `"${String(v).replace(/"/g, '""')}"`;
    const lines = state.history.map(h => [
      h.plate, TYPE_LABEL[h.type], h.owner, h.phone || '', h.slot,
      new Date(h.entry).toLocaleString('en-IN'), new Date(h.exit).toLocaleString('en-IN'),
      fmtDuration(h.exit - h.entry), h.fee
    ].map(cell).join(','));

    const blob = new Blob([[header.map(cell).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'parking-history.csv';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function clearHistory() {
    if (!state.history.length) return toast('History is already empty.');
    openModal('Clear history?', '<p>This permanently deletes all completed parking records.</p>', [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Delete all', cls: 'btn-primary', onClick: () => {
          state.history = [];
          saveState();
          renderAll();
          closeModal();
          toast('History cleared.');
        }
      }
    ]);
  }

  function updateClock() {
    $('clock').textContent = new Date().toLocaleString('en-IN', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  /* ---------- Events ---------- */
  $('entryForm').addEventListener('submit', handleEntry);
  $('type').addEventListener('change', () => { selectedSlot = null; renderSlotSelect(); renderSlotGrid(); });
  $('slot').addEventListener('change', () => { selectedSlot = $('slot').value; renderSlotGrid(); });
  $('slotGrid').addEventListener('click', handleSlotClick);
  $('search').addEventListener('input', renderParked);
  $('parkedBody').addEventListener('click', e => {
    const btn = e.target.closest('[data-checkout]');
    if (btn) openCheckout(btn.dataset.checkout);
  });
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  $('exportBtn').addEventListener('click', exportCsv);
  $('clearBtn').addEventListener('click', clearHistory);
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
  $('phone').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, ''); });

  /* ---------- Start ---------- */
  renderAll();
  updateClock();
  detectServer();
  setInterval(() => {
    updateClock(); renderStats(); renderParked();
    if (!payApi && retryDetect) detectServer();
  }, 30000);
})();

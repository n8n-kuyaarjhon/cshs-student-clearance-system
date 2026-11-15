'use strict';

/* ==========================================================================
   Student Clearance Document Request System — Cabiao Senior High School
   Front end for the server in server.js. Everything shown here comes from
   the school's SQLite database: students, requests, staff, files and mail.
   ========================================================================== */

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const esc = (value) => String(value == null ? '' : value)
    .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const fmtTime = (value) => (value
    ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '');

  const normPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '').replace(/^63/, '').replace(/^0/, '');
    return /^9\d{9}$/.test(digits) ? '+63' + digits : null;
  };

  const fullName = (student) => [student.first_name, student.middle_name, student.last_name]
    .filter(Boolean).join(' ');

  const DOCS = {
    form137_sf10: 'Form 137 / SF10',
    good_moral: 'Good Moral Certificate',
    clearance: 'School Clearance',
    report_card: 'Report Card / Transcript',
  };

  const PURPOSE = {
    employment: 'For Employment',
    university: 'For University',
    military: 'For Military',
    others: 'Others',
  };

  const ID_TYPES = [
    'Philippine Passport', 'Driver’s License', 'UMID', 'PhilSys National ID (PhilID / ePhilID)', 'PRC ID',
    'Postal ID', 'Voter’s ID', 'SSS ID', 'GSIS ID', 'PhilHealth ID', 'TIN ID', 'Senior Citizen ID', 'PWD ID', 'OFW ID (iDOLE)',
  ];

  const PROOF_LABEL = {
    university: 'Proof that the university requested your documents (request letter or admission requirement)',
    military: 'Proof that the head of the military office or unit requested your documents (letter or memorandum)',
    others: 'Proof of the request (optional)',
  };

  const ROLE_VIEWS = {
    public: ['request', 'track', 'about'],
    admin_assistant: ['registrar', 'fulfillment', 'notifications', 'about'],
    principal: ['registrar', 'notifications', 'about'],
    registrar: ['registrar', 'fulfillment', 'accounts', 'notifications', 'about'],
  };

  const ROLE_LABEL = {
    admin_assistant: 'Administrative assistant',
    principal: 'Principal',
    registrar: 'Registrar (administrator)',
  };

  /* ---------- server calls ---------- */
  async function api(path, options = {}) {
    const opts = { method: options.method || 'GET', credentials: 'same-origin', headers: { ...(options.headers || {}) } };
    if (options.body instanceof FormData) {
      opts.body = options.body;
    } else if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(path, opts);
    } catch {
      throw new Error('Cannot reach the server. Check your connection.');
    }

    const text = await res.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text }; }
    }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status}).`);
      err.status = res.status;
      if (res.status === 401) setUser(null);
      throw err;
    }
    return data;
  }

  /* ---------- small UI helpers ---------- */
  function toast(message, via, kind) {
    const el = document.createElement('div');
    el.className = 'bg-white border-l-4 ' + (kind === 'error' ? 'border-bad' : 'border-gold') + ' rounded shadow-lg p-3 text-sm cursor-pointer';
    el.innerHTML = `<div class="font-medium">${esc(message)}</div>` + (via ? `<div class="text-xs text-ink/60 mt-1">${esc(via)}</div>` : '');
    el.onclick = () => el.remove();
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  const say = (el, text, kind) => {
    el.textContent = text;
    el.className = 'text-sm ' + (kind ? 'text-' + kind : '');
  };

  const state = {
    user: null,
    requests: [],
    currentStudent: null,
    foundMatches: [],
    verifiedEmail: '',
    emailToken: '',
    faceShown: undefined,
    viewingId: null,
    approveAfterId: null,
    rejectingId: null,
  };

  /* ==========================================================================
     Navigation
     ========================================================================== */
  function show(view) {
    $$('.view').forEach((section) => section.classList.toggle('hidden', section.id !== 'view-' + view));
    $$('.nav').forEach((button) => {
      const on = button.dataset.view === view;
      button.classList.toggle('bg-gold', on);
      button.classList.toggle('text-ink', on);
      button.classList.toggle('font-medium', on);
    });

    const render = {
      track: renderTrack,
      registrar: renderReview,
      fulfillment: renderFulfillment,
      accounts: renderAccounts,
      notifications: renderInbox,
    }[view];
    if (render) Promise.resolve(render()).catch((err) => toast(err.message, '', 'error'));
  }
  $$('.nav').forEach((button) => { button.onclick = () => show(button.dataset.view); });

  function applyRole(role) {
    const views = ROLE_VIEWS[role] || ROLE_VIEWS.public;
    $$('.nav').forEach((button) => button.classList.toggle('hidden', !views.includes(button.dataset.view)));
    $('#staff-chip').classList.toggle('hidden', role === 'public');
    $('#staff-login-btn').classList.toggle('hidden', role !== 'public');
    return views;
  }

  function setUser(user) {
    state.user = user || null;
    applyRole(state.user ? state.user.role : 'public');
    if (state.user) {
      $('#user-name').textContent = state.user.name;
      $('#user-role').textContent = ROLE_LABEL[state.user.role] || state.user.role;
      renderBell();
    } else {
      $('#user-name').textContent = '';
      $('#user-role').textContent = '';
      $('#nav-badge').classList.add('hidden');
    }
  }

  /* ==========================================================================
     Request a document — finding the learner
     ========================================================================== */
  function showProfile(student) {
    const rows = [
      ['Name', fullName(student)],
      ['Strand', student.strand],
      ['Last grade level', student.last_grade_level],
      ['Section', student.section],
      ['Year graduated', student.year_graduated],
    ];
    $('#profile').innerHTML = rows
      .map(([label, value]) => `<div><dt class="text-ink/60">${label}</dt><dd class="font-medium">${esc(value)}</dd></div>`)
      .join('');
    $('#profile').classList.remove('hidden');
  }

  function resetFound() {
    state.currentStudent = null;
    state.foundMatches = [];
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');
    $('#find-results').classList.add('hidden');
    $('#find-results').innerHTML = '';
    $('#lookup-msg').textContent = '';
    syncRequest();
  }

  function syncFind() {
    const byName = ($('input[name=find]:checked') || {}).value === 'name';
    $('#find-lrn').classList.toggle('hidden', byName);
    $('#find-name').classList.toggle('hidden', !byName);
    $$('#find-card .choice').forEach((label) => {
      const on = label.querySelector('input').checked;
      ['border-brand', 'bg-paper', 'ring-1', 'ring-brand'].forEach((c) => label.classList.toggle(c, on));
    });
  }

  $('#find-card').addEventListener('change', (event) => {
    if (event.target && event.target.name === 'find') {
      resetFound();
      syncFind();
    }
  });

  $('#lookup').onclick = async () => {
    const lrn = $('#lrn').value.trim();
    const msg = $('#lookup-msg');
    state.currentStudent = null;
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');

    if (!/^\d{12}$/.test(lrn)) return say(msg, 'Enter all 12 digits of your LRN.', 'bad');

    try {
      const { student } = await api(`/api/students/lookup/${lrn}`);
      say(msg, 'Record found.', 'ok');
      state.currentStudent = {
        name: fullName(student),
        section: student.last_grade_level ? `Grade ${student.last_grade_level} - ${student.section}` : (student.section || ''),
        complete: true,
        studentToken: student.studentToken,
        lrnShown: student.lrnShown,
      };
      showProfile(student);
      syncRequest();
    } catch (err) {
      if (err.status !== 404) return say(msg, err.message, 'bad');
      say(msg, '');
      $('#manual-title').textContent = 'We could not find that LRN. Enter your details instead.';
      $('#manual').classList.remove('hidden');
      syncRequest();
    }
  };

  $('#find-name-go').onclick = async () => {
    const msg = $('#lookup-msg');
    const list = $('#find-results');
    const val = (id) => $(id).value.trim();
    const filters = {
      first_name: val('#fn-first'),
      last_name: val('#fn-last'),
      middle_name: val('#fn-middle'),
      strand: $('#fn-strand').value,
      year_graduated: val('#fn-year'),
    };

    state.currentStudent = null;
    state.foundMatches = [];
    $('#profile').classList.add('hidden');
    $('#manual').classList.add('hidden');
    list.classList.add('hidden');
    list.innerHTML = '';

    if (!filters.first_name || !filters.last_name) {
      say(msg, 'Enter your first name and last name.', 'bad');
      syncRequest();
      return;
    }

    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const { matches } = await api('/api/students/search?' + query.toString());
      state.foundMatches = matches;

      if (!matches.length) {
        say(msg, 'We could not find a record with these details. Check the spelling, or enter your details below and the Registrar will check them.', 'wait');
        $('#manual-title').textContent = 'We could not find your record. Enter your details instead.';
        ['first_name', 'last_name', 'middle_name', 'strand', 'year_graduated'].forEach((key) => {
          $('#manual [name=' + key + ']').value = filters[key] || '';
        });
        $('#manual').classList.remove('hidden');
        syncRequest();
        return;
      }

      say(msg, matches.length === 1 ? 'We found 1 record. Is this you?' : `We found ${matches.length} records. Pick yours.`, 'ok');
      list.innerHTML = matches.map((match, index) => `<li class="border border-ink/20 rounded p-3 flex items-center justify-between gap-3">
        <div class="text-sm"><b>${esc(fullName(match))}</b><br>
        <span class="text-ink/60">${esc(match.strand)} &middot; Grade ${esc(match.last_grade_level)} - ${esc(match.section)} &middot; Graduated ${esc(match.year_graduated)} &middot; LRN ending ${esc(match.lrn_last4)}</span></div>
        <button type="button" onclick="pickStudent(${index})" class="bg-brand text-white px-3 py-1 rounded font-medium whitespace-nowrap">This is me</button></li>`).join('');
      list.classList.remove('hidden');
      syncRequest();
    } catch (err) {
      say(msg, err.message, 'bad');
    }
  };

  window.pickStudent = function pickStudent(index) {
    const match = state.foundMatches[index];
    state.currentStudent = {
      name: fullName(match),
      section: match.last_grade_level ? `Grade ${match.last_grade_level} - ${match.section}` : (match.section || ''),
      complete: true,
      studentToken: match.studentToken,
      lrnShown: '••••••••' + match.lrn_last4,
    };
    $('#find-results').classList.add('hidden');
    say($('#lookup-msg'), 'Record selected. Check that it is yours before you continue.', 'ok');
    showProfile(match);
    syncRequest();
  };

  /* ==========================================================================
     Request a document — the form
     ========================================================================== */
  function claimerInfo() {
    const val = (id) => $(id).value.trim();
    return {
      type: 'rep',
      repName: val('#au-name'),
      relationship: val('#au-rel'),
      repPhone: val('#au-phone'),
      repIdType: val('#au-idtype'),
      reason: val('#au-reason'),
      signedName: val('#au-sign'),
      signedAt: new Date().toISOString(),
    };
  }

  function syncRequest() {
    const purpose = $('#purpose').value;
    const claimer = ($('input[name=claimer]:checked') || {}).value === 'rep' ? 'rep' : 'self';
    const employment = ($('input[name=emp]:checked') || {}).value;

    $('#purpose-other-wrap').classList.toggle('hidden', purpose !== 'others');
    $('#employment-wrap').classList.toggle('hidden', purpose !== 'employment');
    $('#emp-id-wrap').classList.toggle('hidden', !(purpose === 'employment' && ['local', 'abroad'].includes(employment)));
    $('#university-wrap').classList.toggle('hidden', purpose !== 'university');
    $('#proof-wrap').classList.toggle('hidden', !PROOF_LABEL[purpose]);
    if (PROOF_LABEL[purpose]) $('#proof-label').textContent = PROOF_LABEL[purpose];
    $('#rep-letter').classList.toggle('hidden', claimer !== 'rep');

    $$('#request-form .choice').forEach((label) => {
      const on = label.querySelector('input').checked;
      ['border-brand', 'bg-paper', 'ring-1', 'ring-brand'].forEach((c) => label.classList.toggle(c, on));
    });

    $('#au-learner').textContent = state.currentStudent ? state.currentStudent.name : '(your name)';
    $('#au-lrn').textContent = state.currentStudent
      ? (state.currentStudent.lrnShown || '(LRN not provided)')
      : ($('#lrn').value.trim() || '(your LRN)');
    $('#au-doc').textContent = DOCS[$('#doctype').value];
    $('#au-date').textContent = new Date().toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });

    const face = $('#au-photo').files[0];
    if (face !== state.faceShown) {
      state.faceShown = face;
      $('#au-photo-preview').innerHTML = face
        ? `<img src="${URL.createObjectURL(face)}" alt="Photo of the person who will claim" class="w-28 h-28 rounded object-cover border border-ink/20">`
        : '';
    }
  }

  $('#request-form').addEventListener('change', syncRequest);
  $('#request-form').addEventListener('input', syncRequest);

  /* ---------- Gmail verification ---------- */
  function resetEmailCheck() {
    state.verifiedEmail = '';
    state.emailToken = '';
    $('#email-code-wrap').classList.add('hidden');
    $('#email-code').value = '';
    emailMsg('');
  }

  function emailMsg(text, kind) {
    $('#email-msg').textContent = text;
    $('#email-msg').className = 'text-sm mt-1 ' + (kind ? 'text-' + kind : '');
  }

  $('#req-email').addEventListener('input', () => {
    if (state.verifiedEmail && $('#req-email').value.trim().toLowerCase() !== state.verifiedEmail) resetEmailCheck();
  });

  $('#email-send').onclick = async () => {
    const email = $('#req-email').value.trim().toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/.test(email)) return emailMsg('Enter your Gmail address first, like name@gmail.com.', 'bad');
    try {
      const res = await api('/api/email/send-code', { method: 'POST', body: { email } });
      $('#email-code-wrap').classList.remove('hidden');
      $('#email-code').focus();
      const hint = res.devCode ? ` Demo code: ${res.devCode}` : '';
      emailMsg(`We sent a 6-digit code to ${email}.${hint}`, 'ok');
    } catch (err) {
      emailMsg(err.message, 'bad');
    }
  };

  $('#email-verify').onclick = async () => {
    const email = $('#req-email').value.trim().toLowerCase();
    try {
      const res = await api('/api/email/verify', { method: 'POST', body: { email, code: $('#email-code').value.trim() } });
      state.verifiedEmail = email;
      state.emailToken = res.emailToken;
      $('#email-code-wrap').classList.add('hidden');
      emailMsg(`Gmail verified: ${email}`, 'ok');
    } catch (err) {
      emailMsg(err.message, 'bad');
    }
  };

  /* ---------- submit ---------- */
  function showTrackingCard(request, email) {
    $('#submit-msg').textContent = '';
    $('#tracking-card').innerHTML = `<div class="rounded-md border border-gold bg-gold/10 p-4">
      <p class="text-sm font-medium">Request submitted. Your tracking number is:</p>
      <p class="font-serif text-2xl tracking-wide my-1">${esc(request.tracking)}</p>
      <p class="text-sm text-ink/70">Keep this number. Use it in Track my request to see if your request is on-going or ready for pick-up. We sent it to your Gmail (${esc(email)}). Check your inbox, and your spam folder if you do not see it.</p>
      <div class="flex flex-wrap gap-2 mt-3">
        <button type="button" onclick="copyTracking('${esc(request.tracking)}')" class="px-4 py-2 rounded border border-brand text-brand font-medium">Copy number</button>
        <button type="button" onclick="trackNow('${esc(request.tracking)}')" class="px-4 py-2 rounded bg-brand text-white font-medium">Track this request</button>
      </div></div>`;
  }

  window.copyTracking = async function copyTracking(tracking) {
    try {
      await navigator.clipboard.writeText(tracking);
      toast('Tracking number copied.');
    } catch {
      toast('Copy it by hand: ' + tracking);
    }
  };

  window.trackNow = function trackNow(tracking) {
    $('#track-no').value = tracking;
    show('track');
  };

  $('#request-form').onsubmit = async (event) => {
    event.preventDefault();
    const out = $('#submit-msg');
    const bad = (text) => { out.textContent = text; out.className = 'text-sm text-bad'; };
    $('#tracking-card').innerHTML = '';
    out.textContent = '';
    out.className = 'text-sm';

    const val = (id) => $(id).value.trim();

    let who = state.currentStudent;
    if (!who && !$('#manual').classList.contains('hidden')) {
      const manual = (name) => $('#manual [name=' + name + ']').value.trim();
      if (manual('first_name') && manual('last_name')) {
        who = { name: `${manual('first_name')} ${manual('last_name')}`, complete: false };
      }
    }
    if (!who) return bad('Find your record first: enter your LRN, or choose “I forgot my LRN” and search with your name.');

    const email = val('#req-email').toLowerCase();
    if (!/^[^\s@]+@gmail\.com$/.test(email)) return bad('Enter your Gmail address. We send your updates there.');
    if (!state.emailToken || state.verifiedEmail !== email) return bad('Verify your Gmail first: press Send code, then enter the code we sent to your Gmail.');

    const phoneRaw = val('#req-phone');
    const phone = phoneRaw ? normPhone(phoneRaw) : '';
    if (phoneRaw && !phone) return bad('Enter a valid mobile number, like 0917 123 4567, or leave it blank.');

    const purpose = val('#purpose');
    if (!purpose) return bad('Choose the purpose of your request.');
    if (purpose === 'others' && !val('#purpose-other')) return bad('Please specify the purpose.');

    const employment = ($('input[name=emp]:checked') || {}).value || '';
    if (purpose === 'employment' && !['local', 'abroad'].includes(employment)) return bad('Choose whether the employment is local or abroad.');
    const idType = purpose === 'employment' ? val('#id-type') : '';
    if (purpose === 'employment' && !ID_TYPES.includes(idType)) return bad('Choose the type of government ID.');
    const idFile = purpose === 'employment' ? $('#valid-id').files[0] : null;
    if (purpose === 'employment' && !idFile) return bad('Upload your government ID as your evidence for employment.');
    if (purpose === 'university' && !val('#university-name')) return bad('Enter the name of the university or school that is requesting your documents.');

    const proofFile = $('#proof-file').files[0];
    if (['university', 'military'].includes(purpose) && !proofFile) {
      return bad('Upload the proof of request. ' + PROOF_LABEL[purpose] + '.');
    }

    const claimerRadio = ($('input[name=claimer]:checked') || {}).value;
    let claimant = { type: 'self' };
    let face = null;
    if (claimerRadio === 'rep') {
      claimant = claimerInfo();
      if (!claimant.repName || !claimant.relationship || !claimant.repIdType) {
        return bad('Fill in the authorization letter: the name of the person who will claim, their relationship to you, and the ID they will show.');
      }
      if (claimant.repPhone && !normPhone(claimant.repPhone)) return bad('Enter a valid mobile number for the person who will claim, or leave it blank.');
      if (!claimant.signedName) return bad('Type your full name as your signature on the letter.');
      if (!$('#au-confirm').checked) return bad('Tick the box to confirm that you authorize this person.');
      face = $('#au-photo').files[0];
      if (!face || !/^image\//.test(face.type)) return bad('Upload a clear photo of the face of the person who will claim the document.');
    }

    const fd = new FormData();
    fd.append('doc', $('#doctype').value);
    fd.append('email', email);
    fd.append('emailToken', state.emailToken);
    if (phone) fd.append('phone', phone);
    fd.append('purpose', purpose);
    if (purpose === 'others') fd.append('purposeOther', val('#purpose-other'));
    if (purpose === 'employment') {
      fd.append('employment', employment);
      fd.append('idType', idType);
    }
    if (purpose === 'university') fd.append('university', val('#university-name'));
    if (purpose === 'employment' && idFile) fd.append('idFile', idFile, idFile.name);
    if (proofFile) fd.append('proofFile', proofFile, proofFile.name);

    if (state.currentStudent && state.currentStudent.studentToken) {
      fd.append('studentToken', state.currentStudent.studentToken);
    } else {
      const lrn = $('#lrn').value.trim();
      if (lrn) fd.append('lrn', lrn);
      const manual = (name) => $('#manual [name=' + name + ']').value.trim();
      fd.append('firstName', manual('first_name'));
      fd.append('lastName', manual('last_name'));
      if (manual('middle_name')) fd.append('middleName', manual('middle_name'));
      if (manual('year_graduated')) fd.append('yearGraduated', manual('year_graduated'));
    }

    if (claimerRadio === 'rep') {
      fd.append('claimer', 'rep');
      fd.append('repName', claimant.repName);
      fd.append('relationship', claimant.relationship);
      fd.append('repIdType', claimant.repIdType);
      if (claimant.reason) fd.append('repReason', claimant.reason);
      if (claimant.repPhone) fd.append('repPhone', claimant.repPhone);
      fd.append('signedName', claimant.signedName);
      fd.append('auConfirm', '1');
      fd.append('photo', face, face.name);
    }

    const submitButton = $('#submit-request');
    if (submitButton) submitButton.disabled = true;
    try {
      const res = await api('/api/requests', { method: 'POST', body: fd });
      $('#request-form').reset();
      resetEmailCheck();
      state.currentStudent = null;
      state.foundMatches = [];
      state.faceShown = null;
      $('#profile').classList.add('hidden');
      $('#manual').classList.add('hidden');
      $('#find-results').classList.add('hidden');
      syncRequest();
      showTrackingCard(res.request, email);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      bad(err.message);
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };

  /* ==========================================================================
     Track my request
     ========================================================================== */
  const PICKUP_DISCLAIMER = `<div class="border-l-4 border-wait bg-wait/10 rounded p-3 text-sm">
    <p class="font-medium mb-1">Disclaimer</p>
    <ul class="list-disc pl-5 space-y-1">
      <li>Documents are claimed at the school’s Registrar’s Office. Come only when Track my request says Ready for pick-up.</li>
      <li>Bring your tracking number and a valid ID.</li>
      <li>If the learner named on this request cannot come, the person claiming must bring the authorization letter signed by the learner (print it and sign it by hand), a photocopy of the learner’s valid ID, and their own valid ID.</li>
      <li>The person claiming must be the one in the photo you uploaded. The Registrar’s Office compares the photo with the person who comes.</li>
      <li>Without the signed letter, the Registrar’s Office cannot release the document.</li>
    </ul></div>`;

  function letterHtml(request, full) {
    const claimant = request.claimant && request.claimant.type === 'rep' ? request.claimant : null;
    const blank = '<span class="inline-block border-b border-ink min-w-[12rem]">&nbsp;</span>';
    const day = claimant && claimant.signedAt
      ? new Date(claimant.signedAt).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
      : '____________________';
    const lrn = full ? (request.lrn || 'not provided') : (request.lrnShown || 'not provided');

    return `<div class="mt-3 bg-white border border-ink/30 rounded p-5 font-serif text-sm leading-relaxed shadow-sm">
      <p class="text-center font-bold mb-3">AUTHORIZATION LETTER</p>
      <p class="text-right mb-3">Date: ${esc(day)}</p>
      <p>To the Registrar,<br>Cabiao Senior High School</p>
      <p class="mt-3">I, <b>${esc(request.name)}</b> (LRN ${esc(lrn)}), authorize ${claimant && claimant.repName ? `<b>${esc(claimant.repName)}</b>` : blank}${claimant && claimant.relationship ? ` (my ${esc(claimant.relationship)})` : ''} to claim my <b>${esc(DOCS[request.doc])}</b> (Tracking No. <b>${request.tracking ? esc(request.tracking) : '____________'}</b>)${claimant && claimant.reason ? ` because ${esc(claimant.reason)}` : ''}.</p>
      <p class="mt-3">My representative will show ${claimant && claimant.repIdType ? `their <b>${esc(claimant.repIdType)}</b>` : 'their valid ID'}${claimant && claimant.repPhone ? ` and can be reached at ${esc(claimant.repPhone)}` : ''}. A photocopy of my valid ID is attached.</p>
      <div class="mt-8 w-64">${claimant && claimant.signedName
        ? `<div class="h-8 border-b border-ink font-serif italic text-lg">${esc(claimant.signedName)}</div>`
        : '<div class="border-b border-ink h-8"></div>'}<p class="text-xs mt-1">Signature over printed name of the learner</p></div>
      <p class="text-xs text-ink/60 mt-4 font-sans">${claimant ? 'Filled up online. Print it and sign it by hand before it is claimed.' : 'Sample letter.'}</p></div>`;
  }

  const STAGES = [
    ['received', 'Request received'],
    ['review', 'Under review'],
    ['approved', 'Approved. Preparing your document'],
    ['ready', 'Ready for pick-up'],
    ['claimed', 'Claimed'],
  ];

  const stageBadge = (request) => request.status === 'rejected' ? ['Rejected', 'bg-bad/15 text-bad']
    : request.status === 'pending' ? ['On-going', 'bg-wait/15 text-wait']
      : request.release === 'claimed' ? ['Claimed', 'bg-ink/10 text-ink']
        : request.release === 'ready' ? ['Ready for pick-up', 'bg-ok/15 text-ok']
          : ['On-going', 'bg-wait/15 text-wait'];

  async function renderTrack() {
    const raw = $('#track-no').value;
    const msg = $('#track-msg');
    const list = $('#track-list');
    list.innerHTML = '';

    if (!raw.trim()) {
      say(msg, '', '');
      return;
    }

    let request;
    try {
      ({ request } = await api('/api/track/' + encodeURIComponent(raw.trim())));
    } catch (err) {
      say(msg, err.message, 'bad');
      return;
    }
    say(msg, '', '');

    const [badge, cls] = stageBadge(request);
    const index = request.status === 'pending' ? 1 : request.release === 'claimed' ? 4 : request.release === 'ready' ? 3 : 2;
    const last = STAGES.length - 1;
    const times = {
      received: request.times.received,
      approved: request.times.approved,
      ready: request.times.ready,
      claimed: request.times.claimed,
    };

    const stages = request.status === 'rejected' ? '' : `<ol class="mt-4">${STAGES.map(([key, label], i) => {
      const done = i < index || (i === index && index === last);
      const dot = done ? 'bg-ok' : i === index ? 'bg-gold ring-4 ring-gold/30' : 'bg-ink/20';
      return `<li class="flex gap-3"><div class="flex flex-col items-center">
        <span class="mt-1 w-3 h-3 rounded-full ${dot}"></span>
        ${i < last ? `<span class="flex-1 w-px min-h-[1.5rem] ${i < index ? 'bg-ok/50' : 'bg-ink/15'}"></span>` : ''}
        </div><div class="pb-3">
        <div class="text-sm ${i <= index ? 'font-medium' : 'text-ink/50'}">${label}</div>
        ${i <= index && times[key] ? `<div class="text-xs text-ink/60">${fmtTime(times[key])}</div>` : ''}
        </div></li>`;
    }).join('')}</ol>`;

    const note = request.status === 'rejected'
      ? `<p class="mt-3 text-sm text-bad font-medium">Rejected: ${esc(String(request.reason).replace(/\.+$/, ''))}. Fix this and submit a new request.${request.times.rejected ? `<span class="block text-xs font-normal text-ink/60">${fmtTime(request.times.rejected)}</span>` : ''}</p>`
      : request.release === 'ready' ? '<p class="mt-3 text-sm text-ok font-medium">Your document is ready. Pick it up at the Registrar’s Office. Bring your valid ID and this tracking number.</p>'
        : request.release === 'claimed' ? '<p class="mt-3 text-sm text-ink/70">Your document was released. Thank you!</p>'
          : request.status === 'approved' ? '<p class="mt-3 text-sm text-ink/70">Approved. The school is preparing your document. We will message you when it is ready for pick-up.</p>'
            : '<p class="mt-3 text-sm text-ink/70">Your request is being reviewed.</p>';

    const letter = request.status === 'rejected' ? '' : `<details class="mt-3">
      <summary class="cursor-pointer text-sm underline text-brand">Disclaimer and authorization letter</summary>
      <div class="mt-2">${PICKUP_DISCLAIMER}${letterHtml(request)}</div></details>`;

    const messages = (request.messages || []).map((m) => `<li class="text-xs text-ink/70"><span class="text-ink/50">${fmtTime(m.time)}</span> ${esc(m.message)}</li>`).join('');

    list.innerHTML = `<li class="bg-white border border-ink/15 rounded-md p-4">
      <div class="flex items-start justify-between gap-3">
        <div><div class="font-medium">${esc(DOCS[request.doc])}</div>
          <div class="text-xs text-ink/60">${esc(PURPOSE[request.purpose] || '')}${request.purposeOther ? ' · ' + esc(request.purposeOther) : ''}${request.employment ? ' · ' + esc(request.employment === 'abroad' ? 'Abroad' : 'Local') : ''}${request.university ? ' · ' + esc(request.university) : ''}</div>
          <div class="text-xs text-ink/60 mt-1">Tracking No. <b>${esc(request.tracking)}</b></div></div>
        <span class="text-xs px-2 py-1 rounded whitespace-nowrap ${cls}">${badge}</span></div>
      ${stages}${note}${letter}${messages ? `<ul class="mt-3 border-t border-ink/10 pt-2 space-y-1">${messages}</ul>` : ''}</li>`;
  }

  $('#track-go').onclick = () => renderTrack();
  $('#track-no').onkeydown = (event) => { if (event.key === 'Enter') renderTrack(); };

  /* ==========================================================================
     Staff side — shared helpers
     ========================================================================== */
  async function loadRequests() {
    const { requests } = await api('/api/requests');
    state.requests = requests;
    return requests;
  }

  const isRep = (request) => !!(request.claimant && request.claimant.type === 'rep');

  function purposeSub(request) {
    if (request.purpose === 'others') return request.purposeOther;
    if (request.purpose === 'employment') return request.employment === 'abroad' ? 'Abroad' : 'Local';
    if (request.purpose === 'university') return request.university;
    return '';
  }

  const purposeLabel = (request) => esc(PURPOSE[request.purpose] || '-')
    + (purposeSub(request) ? `<span class="block text-xs text-ink/60">${esc(purposeSub(request))}</span>` : '');

  function claimerLabel(request) {
    if (!isRep(request)) return 'The learner';
    const photo = request.files && request.files.photo
      ? `<img src="/api/files/${request.files.photo.id}" alt="Photo of ${esc(request.claimant.repName)}" class="w-10 h-10 rounded-full object-cover border border-ink/20">`
      : '';
    const check = request.authCheck === 'correct' ? '<span class="block text-xs text-ok">Authorization is correct</span>'
      : request.authCheck === 'not_found' ? '<span class="block text-xs text-bad">Authorization: Not found</span>'
        : '<span class="block text-xs text-wait">Authorization: not checked</span>';
    return `<div class="flex items-center gap-2">${photo}<div><b>${esc(request.claimant.repName)}</b><span class="block text-xs text-ink/60">${esc(request.claimant.relationship)} · ${esc(request.claimant.repIdType)}</span>${check}</div></div>`;
  }

  const STATUS_PILL = { pending: 'bg-wait/15 text-wait', approved: 'bg-ok/15 text-ok', rejected: 'bg-bad/15 text-bad' };

  /* ==========================================================================
     Registrar review
     ========================================================================== */
  async function renderReview() {
    const requests = await loadRequests();
    $('#review-rows').innerHTML = requests.length ? requests.map((request) => `<tr class="border-b border-ink/10 align-top">
      <td class="p-3 font-medium">${esc(request.name)}${request.complete === false ? '<span class="block text-xs font-normal text-wait">Entered by hand. Record needs checking.</span>' : ''}<span class="block text-xs font-normal text-ink/60">${request.lrn ? 'LRN ' + esc(request.lrn) : 'LRN not provided'}</span><span class="block text-xs font-normal text-ink/60">${esc(request.email)} · ${esc(request.tracking)}${request.phone ? ' · ' + esc(request.phone) : ''}</span></td>
      <td class="p-3">${esc(DOCS[request.doc])}</td>
      <td class="p-3">${purposeLabel(request)}</td>
      <td class="p-3">${claimerLabel(request)}</td>
      <td class="p-3"><button onclick="viewDocs(${request.id})" class="underline text-brand font-medium">View documents</button>
        <span class="block text-xs ${request.idVerified ? 'text-ok' : 'text-wait'}">${request.idVerified ? 'Verified' : 'Not checked'}</span></td>
      <td class="p-3"><span class="text-xs px-2 py-1 rounded ${STATUS_PILL[request.status]}">${request.status}</span></td>
      <td class="p-3">${request.status === 'pending' ? `
        <button onclick="approveClick(${request.id})" class="px-3 py-1 rounded bg-ok text-white mr-1">Approve</button>
        <button onclick="openReject(${request.id})" class="px-3 py-1 rounded border border-bad text-bad">Reject</button>
        <span class="block text-xs mt-1 text-ink/60">${request.idVerified ? 'Documents checked. Ready to approve.' : 'Approve opens the documents for a quick check first.'}</span>`
        : request.status === 'approved' ? '<span class="text-ok text-xs">Approved. See Pick-ups.</span>' : '—'}</td></tr>`).join('')
      : '<tr><td colspan="7" class="p-4 text-ink/60">No requests yet.</td></tr>';
  }

  async function decide(id, decision, reason) {
    try {
      await api(`/api/requests/${id}/decision`, { method: 'POST', body: { decision, reason } });
      toast(decision === 'approved'
        ? 'Request approved. The student was emailed.'
        : 'Request rejected. The student was emailed the reason.');
      await renderReview();
      if (!$('#view-fulfillment').classList.contains('hidden')) await renderFulfillment();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  }

  /* ---------- rejection ---------- */
  window.openReject = function openReject(id) {
    state.rejectingId = id;
    $('#reason-text').value = '';
    $('#modal-err').textContent = '';
    $('#modal').classList.remove('hidden');
    $('#reason-select').focus();
  };

  $('#modal-cancel').onclick = () => $('#modal').classList.add('hidden');

  $('#modal-confirm').onclick = async () => {
    const reason = [$('#reason-select').value, $('#reason-text').value.trim()].filter(Boolean).join(' — ');
    if (!reason) {
      $('#modal-err').textContent = 'Give a reason so the student knows what to fix.';
      return;
    }
    $('#modal').classList.add('hidden');
    await decide(state.rejectingId, 'rejected', reason);
  };

  /* ---------- documents ---------- */
  const previewFile = (file, label) => !file ? '' : file.mime === 'application/pdf'
    ? `<object data="/api/files/${file.id}" type="application/pdf" class="w-full h-72"><a href="/api/files/${file.id}" target="_blank" rel="noopener" class="underline">Open the PDF</a></object>`
    : `<img src="/api/files/${file.id}" alt="${esc(label)}" class="max-h-72 max-w-full object-contain mx-auto">`;

  const AUTH_LABEL = { correct: 'Authorization is correct', not_found: 'Not found' };

  function authCheckBox(request) {
    if (request.status !== 'pending') {
      return request.authCheck
        ? `<p class="mt-2 text-sm ${request.authCheck === 'correct' ? 'text-ok' : 'text-bad'}">Authorization: ${AUTH_LABEL[request.authCheck]}</p>`
        : '';
    }
    const button = (value, onClass) => `<button type="button" onclick="setAuth(${request.id},'${value}')" class="px-3 py-1 rounded border ${request.authCheck === value ? onClass : 'border-ink/30'}">${AUTH_LABEL[value]}</button>`;
    return `<div class="mt-3 flex flex-wrap items-center gap-2"><span class="text-sm font-medium">Check the authorization:</span>${button('correct', 'bg-ok text-white border-ok')}${button('not_found', 'bg-bad text-white border-bad')}</div>
      <p class="text-xs text-ink/60 mt-1">Choose Not found if the letter or the photo is missing or cannot be seen.</p>`;
  }

  window.setAuth = async function setAuth(id, value) {
    try {
      const { request } = await api(`/api/requests/${id}/authorization-check`, { method: 'POST', body: { status: value } });
      const index = state.requests.findIndex((item) => item.id === id);
      if (index !== -1) state.requests[index] = request;
      drawDocs();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  window.viewDocs = async function viewDocs(id, approving) {
    state.viewingId = id;
    state.approveAfterId = approving ? id : null;
    if (!state.requests.some((request) => request.id === id)) {
      try {
        await loadRequests();
      } catch (err) {
        toast(err.message, '', 'error');
        return;
      }
    }
    drawDocs();
  };

  function drawDocs() {
    const request = state.requests.find((item) => item.id === state.viewingId);
    if (!request) return;

    const approving = state.approveAfterId === request.id;
    $('#id-meta').textContent = `${request.name} · ${DOCS[request.doc]} · ${request.tracking}`;

    const hasId = Boolean(request.files.id);
    const hasProof = Boolean(request.files.proof);
    const photo = request.files.photo;

    $('#id-view').innerHTML = `<div class="space-y-4">
      ${hasId ? `<div><p class="text-sm font-medium mb-1">Government ID: ${esc(request.idType || 'not stated')} (evidence for employment)</p><div class="border border-ink/15 rounded bg-paper p-2">${previewFile(request.files.id, 'Government ID')}</div></div>` : ''}
      <div><p class="text-sm font-medium">Purpose: ${purposeLabel(request)}</p></div>
      ${hasProof ? `<div><p class="text-sm font-medium mb-1">Proof of request</p><div class="border border-ink/15 rounded bg-paper p-2">${previewFile(request.files.proof, 'Proof of request')}</div></div>` : ''}
      ${!hasId && !hasProof ? '<p class="text-sm text-ink/60">No files are needed for this purpose. Check that the details match the learner.</p>' : ''}
      ${isRep(request) ? `<div><p class="text-sm font-medium">Who will claim: ${esc(request.claimant.repName)}</p>
        <p class="text-xs text-ink/60">Authorization letter, filled up online by the learner. Check the signed printed copy and the IDs when the document is claimed.</p>
        ${photo ? `<div class="border border-ink/15 rounded bg-paper p-2 mt-2"><p class="text-xs font-medium mb-1">Photo of the person who will claim</p><img src="/api/files/${photo.id}" alt="Photo of ${esc(request.claimant.repName)}" class="max-h-56 max-w-full object-contain mx-auto"></div>` : ''}
        ${letterHtml(request, true)}${authCheckBox(request)}</div>`
        : '<p class="text-sm text-ink/70">The learner will claim the document personally.</p>'}
    </div>`;

    const open = request.status === 'pending';
    $('#id-ok').classList.toggle('hidden', !open);
    $('#id-bad').classList.toggle('hidden', !open);
    $('#id-ok').textContent = approving
      ? (request.idVerified ? 'Approve this request' : 'Documents are correct. Approve')
      : 'Documents are correct';
    $('#id-state').textContent = approving
      ? 'Check the documents, then approve this request.'
      : (request.idVerified ? 'You marked these documents as correct.' : '');
    $('#id-modal').classList.remove('hidden');
  }

  $('#id-close').onclick = () => $('#id-modal').classList.add('hidden');

  $('#id-ok').onclick = async () => {
    const request = state.requests.find((item) => item.id === state.viewingId);
    if (!request) return;

    if (isRep(request)) {
      if (request.authCheck === 'not_found') return rejectWith('Authorization not found');
      if (!request.authCheck) return toast('Check the authorization first: choose Authorization is correct or Not found.', '', 'error');
    }

    try {
      let fresh = request;
      if (!request.idVerified) {
        const result = await api(`/api/requests/${request.id}/id-verified`, { method: 'POST', body: {} });
        fresh = result.request;
        const index = state.requests.findIndex((item) => item.id === request.id);
        if (index !== -1) state.requests[index] = fresh;
      }
      const approveNow = state.approveAfterId === request.id;
      state.approveAfterId = null;
      $('#id-modal').classList.add('hidden');
      if (approveNow) return decide(request.id, 'approved');
      toast('Documents marked as correct.');
      await renderReview();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  $('#id-bad').onclick = () => rejectWith('Documents are invalid');

  function rejectWith(reason) {
    $('#id-modal').classList.add('hidden');
    openReject(state.viewingId);
    $('#reason-select').value = reason;
  }

  window.approveClick = function approveClick(id) {
    const request = state.requests.find((item) => item.id === id);
    if (!request) return;
    if (request.idVerified && (!isRep(request) || request.authCheck === 'correct')) decide(id, 'approved');
    else viewDocs(id, true);
  };

  /* ==========================================================================
     Pick-ups
     ========================================================================== */
  async function renderFulfillment() {
    const requests = (await loadRequests()).filter((request) => request.status === 'approved');
    $('#ful-rows').innerHTML = requests.length ? requests.map((request) => {
      const current = request.release === 'claimed' ? 'Claimed' : request.release === 'ready' ? 'Ready for pick-up' : 'Preparing';
      const action = request.release === 'claimed'
        ? `<span class="text-ok text-xs">Claimed by ${esc(request.claimedBy || 'the learner')} · ${fmtTime(request.times.claimed)}</span>`
        : request.release === 'ready'
          ? `${isRep(request) ? `<span class="block text-xs text-wait mb-1">Compare the photo with the person claiming, then check the signed letter, the learner’s ID copy and their ${esc(request.claimant.repIdType)}.</span>` : ''}<input id="claim-${request.id}" value="${esc(isRep(request) ? request.claimant.repName : request.name)}" placeholder="Claimed by (name)" class="border border-ink/30 rounded px-2 py-1 w-44 mr-1 mb-1 text-sm"><button onclick="advance(${request.id})" class="px-3 py-1 rounded bg-brand text-white mb-1">Mark claimed</button>`
          : `<button onclick="advance(${request.id})" class="px-3 py-1 rounded bg-brand text-white">Mark ready for pick-up</button>`;

      return `<tr class="border-b border-ink/10 align-top">
        <td class="p-3 font-medium">${esc(request.name)}<span class="block text-xs font-normal text-ink/60">${esc(DOCS[request.doc])} · ${esc(request.tracking)}</span></td>
        <td class="p-3">${purposeLabel(request)}</td>
        <td class="p-3">${claimerLabel(request)}</td>
        <td class="p-3">${current}</td>
        <td class="p-3">${action}</td></tr>`;
    }).join('') : '<tr><td colspan="5" class="p-4 text-ink/60">No approved requests yet.</td></tr>';
  }

  window.advance = async function advance(id) {
    const request = state.requests.find((item) => item.id === id);
    if (!request) return;
    try {
      if (request.release === 'preparing' || !request.release) {
        await api(`/api/requests/${id}/release`, { method: 'POST', body: { status: 'ready_for_pickup' } });
        toast('Marked ready for pick-up. The student was emailed.');
      } else if (request.release === 'ready') {
        const input = $('#claim-' + id);
        const claimedBy = input ? input.value.trim() : '';
        if (!claimedBy) return toast('Type who claimed the document first.', '', 'error');
        await api(`/api/requests/${id}/release`, { method: 'POST', body: { status: 'claimed', claimedBy } });
        toast('Document released.');
      }
      await renderFulfillment();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  /* ==========================================================================
     Notifications
     ========================================================================== */
  async function renderBell() {
    if (!state.user) {
      $('#nav-badge').classList.add('hidden');
      return;
    }
    try {
      const { unread } = await api('/api/notifications');
      const badge = $('#nav-badge');
      badge.textContent = unread;
      badge.classList.toggle('hidden', !unread);
    } catch { /* the poll is allowed to fail quietly */ }
  }

  async function renderInbox() {
    const { items } = await api('/api/notifications');
    $('#inbox-list').innerHTML = items.length ? items.map((item) => `<li class="bg-white border ${item.read ? 'border-ink/15' : 'border-gold border-l-4'} rounded-md p-4">
      <div class="font-medium">${esc(item.message)}</div>
      <div class="text-xs text-ink/60 mt-1">${fmtTime(item.time)} · ${esc(item.via)}</div></li>`).join('')
      : '<li class="text-ink/60">No notifications yet.</li>';
    await api('/api/notifications/read', { method: 'POST', body: {} });
    await renderBell();
  }

  /* ==========================================================================
     Manage accounts
     ========================================================================== */
  async function renderAccounts() {
    const { users } = await api('/api/admin/users');
    $('#staff-rows').innerHTML = users.map((user) => `<tr class="border-b border-ink/10">
      <td class="p-3 font-medium">${esc(user.name)}</td>
      <td class="p-3">${ROLE_LABEL[user.role] || esc(user.role)}</td>
      <td class="p-3">${esc(user.phone || '-')}</td>
      <td class="p-3">${esc(user.email || '-')}</td>
      <td class="p-3">${user.active ? '<span class="text-ok">Active</span>' : '<span class="text-bad">Turned off</span>'}</td>
      <td class="p-3">${state.user && user.id === state.user.id
        ? '<span class="text-ink/50">You</span>'
        : `<button onclick="toggleStaff(${user.id}, ${user.active ? 'false' : 'true'})" class="px-3 py-1 rounded border ${user.active ? 'border-bad text-bad' : 'border-ok text-ok'}">${user.active ? 'Turn off' : 'Turn on'}</button>`}</td></tr>`).join('');
  }

  window.toggleStaff = async function toggleStaff(id, active) {
    try {
      await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { active } });
      await renderAccounts();
    } catch (err) {
      toast(err.message, '', 'error');
    }
  };

  $('#staff-form').onsubmit = async (event) => {
    event.preventDefault();
    const msg = $('#staff-msg');
    const bad = (text) => { msg.textContent = text; msg.className = 'text-sm text-bad'; };

    const name = $('#staff-name').value.trim();
    const role = $('#staff-role').value;
    const phoneRaw = $('#staff-phone').value.trim();
    const email = $('#staff-email').value.trim().toLowerCase();

    if (!name) return bad('Enter the full name.');
    if (!phoneRaw && !email) return bad('Enter a mobile number or a Gmail so they can log in.');
    if (phoneRaw && !normPhone(phoneRaw)) return bad('Enter a valid mobile number, like 0917 123 4567.');
    if (email && !/^[^\s@]+@gmail\.com$/.test(email)) return bad('Enter a Gmail address.');

    try {
      await api('/api/admin/users', { method: 'POST', body: { name, role, phone: phoneRaw || null, email: email || null } });
      event.target.reset();
      msg.textContent = `${name} can now log in as ${ROLE_LABEL[role]}.`;
      msg.className = 'text-sm text-ok';
      await renderAccounts();
    } catch (err) {
      bad(err.message);
    }
  };

  /* ==========================================================================
     Staff log in
     ========================================================================== */
  let otpPhone = '';

  function authMsg(text, ok) {
    const el = $('#auth-msg');
    el.textContent = text;
    el.className = 'text-sm ' + (ok ? 'text-ok' : 'text-bad');
  }

  function resetAuth() {
    otpPhone = '';
    $('#phone-step').classList.remove('hidden');
    $('#otp-step').classList.add('hidden');
    $('#auth-submit').textContent = 'Send code';
    authMsg('', true);
  }

  function openAuth() {
    resetAuth();
    $('#auth-phone').value = '';
    $('#auth').classList.remove('hidden');
    $('#auth-phone').focus();
  }

  function closeAuth() {
    $('#auth').classList.add('hidden');
    $('#google-modal').classList.add('hidden');
  }

  $('#staff-login-btn').onclick = openAuth;
  $('#auth-cancel').onclick = closeAuth;
  $('#otp-back').onclick = resetAuth;

  $('#auth-form').onsubmit = async (event) => {
    event.preventDefault();

    if (!otpPhone) {
      const phone = normPhone($('#auth-phone').value);
      if (!phone) return authMsg('Enter a valid mobile number, like 0917 123 4567.');
      try {
        const res = await api('/api/auth/otp/send', { method: 'POST', body: { phone } });
        otpPhone = phone;
        $('#phone-step').classList.add('hidden');
        $('#otp-step').classList.remove('hidden');
        $('#otp-hint').textContent = `We sent a 6-digit code to ${phone}.${res.devCode ? ' Demo code: ' + res.devCode : ''}`;
        $('#auth-submit').textContent = 'Log in';
        $('#auth-otp').value = '';
        $('#auth-otp').focus();
        authMsg('Code sent.', true);
      } catch (err) {
        authMsg(err.message);
      }
      return;
    }

    try {
      const { user } = await api('/api/auth/otp/verify', { method: 'POST', body: { phone: otpPhone, code: $('#auth-otp').value.trim() } });
      onLogin(user);
    } catch (err) {
      authMsg(err.message);
    }
  };

  $('#google-btn').onclick = () => {
    $('#g-error').textContent = '';
    $('#g-other').value = '';
    $('#google-modal').classList.remove('hidden');
  };

  window.googlePick = async function googlePick(email) {
    const fail = (text) => { $('#g-error').textContent = text; };
    email = String(email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Enter a valid email address.');
    try {
      const { user } = await api('/api/auth/google', { method: 'POST', body: { email } });
      onLogin(user);
    } catch (err) {
      fail(err.message);
    }
  };

  function onLogin(user) {
    closeAuth();
    setUser(user);
    const views = applyRole(user.role);
    show(views[0]);
    toast(`Signed in as ${user.name}.`);
  }

  $('#logout').onclick = async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* already signed out */ }
    setUser(null);
    applyRole('public');
    show('request');
  };

  /* ==========================================================================
     Boot
     ========================================================================== */
  $('#id-type').innerHTML = '<option value="">Select the type of government ID</option>'
    + ID_TYPES.map((type) => `<option>${esc(type)}</option>`).join('');
  $('#disclaimer-box').innerHTML = PICKUP_DISCLAIMER;

  syncFind();
  syncRequest();
  applyRole('public');
  show('request');

  function openFromHash() {
    const match = /^#track-(CSHS-[A-Z0-9]{4}-[A-Z0-9]{4})$/.exec(location.hash);
    if (match) {
      $('#track-no').value = match[1];
      show('track');
    }
  }
  window.addEventListener('hashchange', openFromHash);
  openFromHash();

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    $('#modal').classList.add('hidden');
    $('#id-modal').classList.add('hidden');
    $('#auth').classList.add('hidden');
    $('#google-modal').classList.add('hidden');
  });

  api('/api/me').then(({ user }) => {
    if (user) setUser(user);
  }).catch(() => toast('The server is not reachable. Start it with: node server.js', '', 'error'));

  setInterval(() => { if (state.user) renderBell(); }, 30000);
})();

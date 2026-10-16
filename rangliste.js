// Web-Version: freiwilliges öffentliches Profil und Wochenrangliste (Entscheidungen vom 16.10.2026, siehe CLAUDE.md).
// Punkte: richtig gelöste Variante, Stufe 1 = 1 Punkt bis Stufe 4 = 4 Punkte. Woche Mo bis So 23:59 (Europe/Berlin).
// Nach Wochenende legt der erste Browser mit sichtbarem Profil wochen/<Woche> an: die ersten drei (Gleichstand
// eingeschlossen) mit mindestens 40 Punkten. Jeder Browser holt danach seine eigenen Aufstiege nach; die Regeln in
// firestore.rules lassen ein Level nur zu, wenn das Konto in der Wochenauswertung steht.
(function () {
  'use strict';
  const KONFIG = window.WEB_KONFIG;
  const { fs, auth } = window.WEB.intern;
  const ZIEL = 40;
  const START_WOCHE = '0000-W00';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const jetzt = () => window.WEB_JETZT ? new Date(window.WEB_JETZT) : new Date();   // Tests stellen die Uhr

  // ---------------------------------------------------------------- Wochen in Berliner Zeit

  function berlin(d) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
    return { y: +p.year, m: +p.month, t: +p.day, h: +p.hour, min: +p.minute };
  }
  const tagUtc = (b, plus) => new Date(Date.UTC(b.y, b.m - 1, b.t + (plus || 0)));
  const wochentag = d => (d.getUTCDay() + 6) % 7;                 // Mo = 0
  function wocheVon(d) {                                             // d: UTC-Mitternacht eines Kalendertags
    const donnerstag = new Date(d.getTime() + (3 - wochentag(d)) * 864e5);
    const jahr = donnerstag.getUTCFullYear();
    const jan4 = new Date(Date.UTC(jahr, 0, 4));
    const montag1 = jan4.getTime() - wochentag(jan4) * 864e5;
    const nr = 1 + Math.floor((donnerstag.getTime() - montag1) / (7 * 864e5));
    return jahr + '-W' + String(nr).padStart(2, '0');
  }
  const dieseWoche = () => wocheVon(tagUtc(berlin(jetzt())));
  const vorigeWoche = () => wocheVon(tagUtc(berlin(jetzt()), -7));
  const wocheVonZeit = iso => wocheVon(tagUtc(berlin(new Date(iso))));
  function wochenSpanne() {
    const b = berlin(jetzt()), heute = tagUtc(b), mo = new Date(heute.getTime() - wochentag(heute) * 864e5);
    const so = new Date(mo.getTime() + 6 * 864e5);
    const kurz = d => d.getUTCDate() + '.' + (d.getUTCMonth() + 1) + '.';
    const tage = [];
    for (let i = -1; i <= wochentag(heute) + 1; i++) tage.push(new Date(mo.getTime() + i * 864e5).toISOString().slice(0, 10));
    return { text: 'Mo ' + kurz(mo) + ' – So ' + kurz(so), tage };
  }
  function restzeit() {
    const b = berlin(jetzt());
    const min = (7 - wochentag(tagUtc(b))) * 1440 - (b.h * 60 + b.min);
    const t = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
    return t ? t + ' T ' + h + ' Std' : h + ' Std ' + (min % 60) + ' Min';
  }
  const wochenNr = w => Number(w.slice(6));

  // ---------------------------------------------------------------- Daten

  let uid = null;
  let profil = null;            // eigenes Dokument oder null
  let geladen = null;           // Promise der Startroutine
  let cache = { zeit: 0, liste: [], vorwoche: null };
  const profilRef = u => fs.collection('profile').doc(u || uid);

  async function ladeProfil() {
    const s = await profilRef().get();
    profil = s.exists ? s.data() : null;
    return profil;
  }

  // Neue Woche: alte Punkte wandern nach vorwoche, damit die Auswertung sie noch findet
  function mitWoche(p, w) {
    return p.woche === w ? {} : { vorwoche: { woche: p.woche, punkte: p.punkte }, woche: w, punkte: 0 };
  }

  async function wochenwechsel() {
    const w = dieseWoche();
    if (!profil || profil.woche >= w) return;
    await fs.runTransaction(async t => {
      const s = await t.get(profilRef());
      if (!s.exists || s.data().woche >= w) return;
      t.update(profilRef(), mitWoche(s.data(), w));
    });
    await ladeProfil();
  }

  function punkteIn(p, w) {
    if (p.woche === w) return p.punkte;
    if (p.vorwoche && p.vorwoche.woche === w) return p.vorwoche.punkte;
    return 0;
  }

  function aufsteiger(eintraege) {       // [{uid, name, punkte}] -> Aufsteiger mit Gleichstand auf Platz 3
    const sortiert = eintraege.filter(e => e.punkte >= ZIEL).sort((a, b) => b.punkte - a.punkte);
    return sortiert.filter(e => 1 + sortiert.filter(x => x.punkte > e.punkte).length <= 3).slice(0, 20);
  }

  async function holeSichtbare() {
    const q = await fs.collection('profile').where('sichtbar', '==', true).get();
    return q.docs.map(d => Object.assign({ uid: d.id }, d.data()));
  }

  async function auswerten() {
    if (!profil || !profil.sichtbar) return;
    const p = vorigeWoche();
    const ref = fs.collection('wochen').doc(p);
    if ((await ref.get()).exists) return;
    const alle = (await holeSichtbare()).map(x => ({ uid: x.uid, name: x.name, punkte: punkteIn(x, p) }));
    if (!alle.some(x => x.punkte > 0)) return;      // Woche ohne Rangliste (vor dem Start): keine Auswertung
    const auf = aufsteiger(alle);
    await fs.runTransaction(async t => {
      if ((await t.get(ref)).exists) return;          // ein anderer Browser war schneller
      t.set(ref, { uids: auf.map(a => a.uid), liste: auf });
    });
  }

  async function levelNachholen() {
    if (!profil) return;
    const q = await fs.collection('wochen').where('uids', 'array-contains', uid).get();
    const wochen = q.docs.map(d => d.id).filter(w => w > profil.levelWoche).sort();
    for (const w of wochen) {
      await fs.runTransaction(async t => {
        const s = await t.get(profilRef());
        const d = s.data();
        if (d.levelWoche >= w) return;
        t.update(profilRef(), { level: d.level + 1, levelWoche: w });
      });
    }
    if (wochen.length) await ladeProfil();
  }

  async function start(user) {
    uid = user.uid;
    try {
      await ladeProfil();
      await wochenwechsel();
      await auswerten();
      await levelNachholen();
    } catch (e) { console.warn('Rangliste:', e && e.code || e); }
  }

  // Aus der App: eine Variante ist richtig gelöst
  async function geloest(stufe) {
    if (!uid) return;
    if (geladen) await geladen;
    if (!profil) return;
    const w = dieseWoche();
    const plus = Math.max(0, Math.min(4, Math.round(stufe) || 0));
    try {
      await fs.runTransaction(async t => {
        const s = await t.get(profilRef());
        if (!s.exists) return;
        const d = s.data();
        const neu = mitWoche(d, w);
        const basis = d.woche === w ? d.punkte : 0;
        neu.punkte = Math.min(5000, basis + plus);
        t.update(profilRef(), neu);
      });
      await ladeProfil();
      cache.zeit = 0;
    } catch (e) { console.warn('Punkte nicht gespeichert:', e && e.code || e); }
  }

  // Punkte dieser Woche aus dem eigenen Protokoll, damit ein neues Profil nicht bei null anfängt
  async function punkteAusProtokoll() {
    const w = dieseWoche();
    let summe = 0;
    for (const tag of wochenSpanne().tage) {
      const s = await fs.collection('nutzer').doc(uid).collection('versuche').doc(tag).get();
      if (!s.exists) continue;
      for (const e of s.data().e || []) if (e.ok && e.zeit && wocheVonZeit(e.zeit) === w) summe += Math.max(0, Math.min(4, Number(e.s) || 0));
    }
    return Math.min(5000, summe);
  }

  async function profilZeigen(name, bild) {
    const w = dieseWoche();
    if (profil) {
      await profilRef().update(Object.assign({ sichtbar: true, name, bild }, mitWoche(profil, w)));
    } else {
      await profilRef().set({ sichtbar: true, name, bild, level: 0, levelWoche: START_WOCHE, woche: w, punkte: await punkteAusProtokoll() });
    }
    await ladeProfil();
    await auswerten().catch(() => {});
    cache.zeit = 0;
  }

  // ---------------------------------------------------------------- Bild verkleinern

  function bildLesen(datei) {
    return new Promise((ok, fehler) => {
      if (!datei || !/^image\//.test(datei.type)) return fehler(new Error('Bitte ein Bild auswählen (JPG, PNG, WebP).'));
      const url = URL.createObjectURL(datei);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 128;
        const k = Math.min(img.naturalWidth, img.naturalHeight);
        c.getContext('2d').drawImage(img, (img.naturalWidth - k) / 2, (img.naturalHeight - k) / 2, k, k, 0, 0, 128, 128);
        URL.revokeObjectURL(url);
        let q = 0.85, d = c.toDataURL('image/jpeg', q);
        while (d.length > 55000 && q > 0.3) { q -= 0.15; d = c.toDataURL('image/jpeg', q); }
        ok(d);
      };
      img.onerror = () => { URL.revokeObjectURL(url); fehler(new Error('Das Bild konnte nicht gelesen werden.')); };
      img.src = url;
    });
  }

  const istBild = b => typeof b === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(b);
  const ava = (p, gross) => `<span class="rl-ava${gross ? ' gross' : ''}">${istBild(p.bild) ? `<img src="${p.bild}" alt="">` : esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;

  // ---------------------------------------------------------------- Ansicht

  let ziel = null;              // #app, solange die Rangliste offen ist
  let entwurfBild;              // Bild im Zustimmungsformular, noch nicht gespeichert

  function istOffen() { return ziel && document.body.contains(ziel) && /^#\/rangliste/.test(location.hash); }

  async function zeichne(app) {
    ziel = app;
    if (!geladen) { app.innerHTML = '<p class="muted">Rangliste wird geladen …</p>'; return; }
    await geladen;
    if (!istOffen()) return;
    if (!profil || !profil.sichtbar) return zeichneZustimmung(app);
    app.innerHTML = '<p class="muted">Rangliste wird geladen …</p>';
    try {
      if (Date.now() - cache.zeit > 20000) {
        const [liste, vw] = await Promise.all([holeSichtbare(), fs.collection('wochen').doc(vorigeWoche()).get()]);
        cache = { zeit: Date.now(), liste, vorwoche: vw.exists ? vw.data() : null };
      }
    } catch (e) {
      app.innerHTML = `<p class="rl-fehler">Rangliste konnte nicht geladen werden (${esc(e && e.code || 'Fehler')}). Lad die Seite neu.</p>`;
      return;
    }
    if (!istOffen()) return;
    zeichneListe(app);
  }

  function zeichneZustimmung(app, fehler) {
    const wieder = profil && !profil.sichtbar;
    app.innerHTML = `<div class="rl">
      <nav class="zurueck"><a href="#/">← Übersicht</a></nav>
      <p class="eyebrow">Rangliste</p><h1>Mit anderen vergleichen</h1>
      <form class="rl-karte rl-zustimmung" id="rl-zust">
        <p>Die Rangliste ist freiwillig. Um sie zu sehen, brauchst du ein öffentliches Profil. Dann sehen alle anderen mit öffentlichem Profil:</p>
        <ul><li>deinen Anzeigenamen und dein Profilbild</li><li>dein Level und deine Punkte dieser Woche</li></ul>
        <p class="klein muted">Deine Themen, Stufen, Antworten und Fehler sieht niemand. Du kannst das Profil jederzeit verbergen, dann verschwindest du sofort aus der Rangliste.${wieder ? ' Dein Level ' + profil.level + ' ist noch gespeichert.' : ''}</p>
        <label class="rl-feld" for="rl-name">Anzeigename, muss nicht dein echter Name sein
          <input id="rl-name" maxlength="24" autocomplete="nickname" placeholder="z. B. Vincent oder physik_vince" required></label>
        <div class="rl-bildwahl">${ava({ name: '?', bild: entwurfBild })}
          <label class="knopf leise" for="rl-datei">Bild auswählen (optional)</label><input type="file" id="rl-datei" accept="image/*" hidden></div>
        <label class="rl-check" for="rl-ok"><input type="checkbox" id="rl-ok" required>
          <span>Ich bin einverstanden, dass Name, Bild, Level und Wochenpunkte für andere Nutzer mit öffentlichem Profil sichtbar sind.</span></label>
        ${fehler ? `<p class="rl-fehler" role="alert">${esc(fehler)}</p>` : ''}
        <div><button type="submit" class="pruefen">Öffentliches Profil ${wieder ? 'wieder anzeigen' : 'anlegen'}</button></div>
        <p class="klein muted">Mehr dazu im <a href="datenschutz.html#rangliste">Datenschutz</a>.</p>
      </form></div>`;
    const name = app.querySelector('#rl-name');
    app.querySelector('#rl-datei').addEventListener('change', async e => {
      try { entwurfBild = await bildLesen(e.target.files[0]); app.querySelector('.rl-bildwahl .rl-ava').outerHTML = ava({ name: name.value || '?', bild: entwurfBild }); }
      catch (err) { zeichneZustimmung(app, err.message); }
    });
    app.querySelector('#rl-zust').addEventListener('submit', async e => {
      e.preventDefault();
      const n = name.value.trim().replace(/\s+/g, ' ');
      if (!n || n.length > 24) return zeichneZustimmung(app, 'Bitte einen Namen mit 1 bis 24 Zeichen eingeben.');
      if (!app.querySelector('#rl-ok').checked) return zeichneZustimmung(app, 'Ohne Einverständnis geht es nicht.');
      e.submitter && (e.submitter.disabled = true);
      try { await profilZeigen(n, entwurfBild || null); entwurfBild = undefined; zeichne(app); }
      catch (err) { zeichneZustimmung(app, 'Speichern fehlgeschlagen (' + (err && err.code || 'Fehler') + '). Versuch es noch einmal.'); }
    });
  }

  function zeile(p, platz, max, auf) {
    const ok = p.punkte >= ZIEL;
    const ich = p.uid === uid;
    return `<li class="rl-zeile${ich ? ' ich' : ''}" data-uid="${esc(p.uid)}">
      <span class="rl-platz">${platz}.</span>${ava(p)}
      <span class="rl-wer"><span class="rl-name">${esc(p.name)}<span class="rl-level">Level ${p.level}</span></span>
        <span class="rl-ziel${ok ? ' ok' : ''}">${ok ? 'Wochenziel geschafft' : 'noch ' + (ZIEL - p.punkte) + ' Punkte bis zum Wochenziel'}</span></span>
      <span class="rl-mess"><span class="rl-spur" role="img" aria-label="${p.punkte} Punkte"><span style="width:${(p.punkte / max * 100).toFixed(1)}%"></span><i style="left:${(ZIEL / max * 100).toFixed(1)}%"></i></span>
        <span class="rl-zahl">${p.punkte}</span></span>
      ${ich ? '<span></span>' : `<details class="rl-melden"><summary aria-label="Melden">⋯</summary><div><button type="button" data-grund="name">Name melden</button>${p.bild ? '<button type="button" data-grund="bild">Bild melden</button>' : ''}</div></details>`}
    </li>`;
  }

  function zeichneListe(app) {
    const w = dieseWoche();
    const liste = cache.liste.map(p => Object.assign({}, p, { punkte: punkteIn(p, w) })).sort((a, b) => b.punkte - a.punkte || a.name.localeCompare(b.name));
    const aufIds = new Set(aufsteiger(liste).map(a => a.uid));
    const max = Math.max(ZIEL, ...liste.map(p => p.punkte)) * 1.08;
    const platz = p => 1 + liste.filter(x => x.punkte > p.punkte).length;
    const oben = liste.filter(p => aufIds.has(p.uid)), rest = liste.filter(p => !aufIds.has(p.uid));
    const vw = cache.vorwoche;
    let meldung = '';
    if (vw) {
      const namen = vw.liste.map(a => a.name);
      meldung = vw.uids.includes(uid) ? `Du bist aufgestiegen und jetzt auf <b>Level ${profil.level}</b>.`
        : namen.length ? 'Aufgestiegen: <b>' + namen.map(esc).join(', ') + '</b>.' : 'Letzte Woche hat niemand das Wochenziel von 40 Punkten geschafft.';
      meldung = `<div class="rl-meldung"><span class="rl-pokal">Woche ${wochenNr(vorigeWoche())}</span><span>${meldung}</span></div>`;
    }
    app.innerHTML = `<div class="rl">
      <nav class="zurueck"><a href="#/">← Übersicht</a></nav>
      <div class="rl-kopf"><div><p class="eyebrow">Woche ${wochenNr(w)} · ${wochenSpanne().text} · ${liste.length} ${liste.length === 1 ? 'Person' : 'Leute'}</p><h1>Rangliste</h1></div>
        <div class="rl-uhr"><b>${restzeit()}</b><span class="klein muted">bis Sonntag 23:59</span></div></div>
      ${meldung}
      <ol class="rl-karte rl-liste">
        ${oben.length ? '<li class="rl-zone">Aufstieg, wenn die Woche jetzt endet</li>' + oben.map(p => zeile(p, platz(p), max)).join('') : ''}
        ${rest.length ? `<li class="rl-zone grau">${oben.length ? 'weitere Plätze' : 'Aufsteigen kann, wer unter den ersten drei ist und 40 Punkte hat'}</li>` + rest.map(p => zeile(p, platz(p), max)).join('') : ''}
      </ol>
      <p class="rl-legende klein muted">Punkte für richtig gelöste Aufgaben: Stufe 1 = 1 Punkt bis Stufe 4 = 4 Punkte · Wochenziel 40 Punkte</p>
      <div class="rl-unten">
        <section class="rl-karte rl-profil" aria-labelledby="rl-t-profil">
          <h2 id="rl-t-profil">Dein öffentliches Profil</h2>
          <div class="rl-bildwahl">${ava(profil, true)}<label class="knopf leise" for="rl-datei">Bild ändern</label><input type="file" id="rl-datei" accept="image/*" hidden>
            ${profil.bild ? '<button type="button" class="leise" id="rl-bild-weg">Bild entfernen</button>' : ''}</div>
          <form id="rl-name-form" class="rl-namezeile"><label class="rl-feld" for="rl-name">Anzeigename<input id="rl-name" maxlength="24" value="${esc(profil.name)}" required></label>
            <button type="submit" class="leise">Speichern</button></form>
          <p class="rl-status klein muted" id="rl-status" role="status"></p>
          <div><button type="button" class="leise" id="rl-verbergen">Profil verbergen</button></div>
        </section>
        <section class="rl-karte" aria-labelledby="rl-t-regeln">
          <h2 id="rl-t-regeln">So steigt man auf</h2>
          <ul class="klein"><li>Die Woche läuft von Montag bis Sonntag 23:59.</li>
            <li>Die ersten drei steigen ein Level auf, wenn sie mindestens 40 Punkte haben. Bei Gleichstand steigen alle Punktgleichen auf.</li>
            <li>Absteigen kann man nicht.</li></ul>
          <p class="klein muted">Unpassender Name oder Bild? Über ⋯ in der Zeile kannst du es melden.</p>
        </section>
      </div>
      <div id="rl-admin"></div>
    </div>`;
    verdrahteListe(app);
    if (KONFIG.admin && uid === KONFIG.admin) zeichneAdmin(app.querySelector('#rl-admin'));
  }

  function status(app, text) { const s = app.querySelector('#rl-status'); if (s) s.textContent = text; }

  function verdrahteListe(app) {
    const nachher = async (fn, text) => {
      try { await fn(); await ladeProfil(); cache.zeit = 0; await zeichne(app); status(app, text); }
      catch (e) { status(app, 'Speichern fehlgeschlagen (' + (e && e.code || e.message || 'Fehler') + ').'); }
    };
    app.querySelector('#rl-datei').addEventListener('change', async e => {
      let b;
      try { b = await bildLesen(e.target.files[0]); } catch (err) { return status(app, err.message); }
      nachher(() => profilRef().update({ bild: b }), 'Bild gespeichert.');
    });
    const weg = app.querySelector('#rl-bild-weg');
    if (weg) weg.addEventListener('click', () => nachher(() => profilRef().update({ bild: null }), 'Bild entfernt.'));
    app.querySelector('#rl-name-form').addEventListener('submit', e => {
      e.preventDefault();
      const n = app.querySelector('#rl-name').value.trim().replace(/\s+/g, ' ');
      if (!n || n.length > 24) return status(app, 'Bitte einen Namen mit 1 bis 24 Zeichen eingeben.');
      nachher(() => profilRef().update({ name: n }), 'Name gespeichert.');
    });
    app.querySelector('#rl-verbergen').addEventListener('click', () =>
      nachher(() => profilRef().update({ sichtbar: false, name: null, bild: null }), ''));
    app.querySelectorAll('.rl-melden button').forEach(b => b.addEventListener('click', async () => {
      const zeile = b.closest('.rl-zeile'), det = b.closest('details');
      try {
        await fs.collection('meldungen').add({ von: uid, ueber: zeile.dataset.uid, grund: b.dataset.grund });
        det.querySelector('div').innerHTML = '<span class="klein">Danke, ist gemeldet.</span>';
      } catch (e) { det.querySelector('div').innerHTML = '<span class="klein">Melden fehlgeschlagen.</span>'; }
    }));
  }

  async function zeichneAdmin(el) {
    try {
      const q = await fs.collection('meldungen').get();
      if (!q.docs.length) { el.innerHTML = '<section class="rl-karte rl-admin"><h2>Meldungen</h2><p class="klein muted">Keine offenen Meldungen.</p></section>'; return; }
      const namen = Object.fromEntries(cache.liste.map(p => [p.uid, p]));
      el.innerHTML = `<section class="rl-karte rl-admin"><h2>Meldungen (nur für dich)</h2><ul>${q.docs.map(d => {
        const m = d.data(), p = namen[m.ueber];
        return `<li data-id="${esc(d.id)}" data-uid="${esc(m.ueber)}" data-grund="${esc(m.grund)}">${p ? ava(p) + ' <b>' + esc(p.name) + '</b>' : esc(m.ueber) + ' (nicht mehr sichtbar)'} · ${m.grund === 'bild' ? 'Bild' : 'Name'} gemeldet
          ${p ? `<button type="button" class="leise" data-a="zuruecksetzen">${m.grund === 'bild' ? 'Bild entfernen' : 'Name zurücksetzen'}</button>` : ''}
          <button type="button" class="leise" data-a="erledigt">Erledigt</button></li>`;
      }).join('')}</ul></section>`;
      el.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
        const li = b.closest('li');
        try {
          if (b.dataset.a === 'zuruecksetzen') await profilRef(li.dataset.uid).update(li.dataset.grund === 'bild' ? { bild: null } : { name: 'Name entfernt' });
          await fs.collection('meldungen').doc(li.dataset.id).delete();
          li.remove();
          cache.zeit = 0;
        } catch (e) { b.textContent = 'Fehlgeschlagen'; }
      }));
    } catch (e) { el.innerHTML = ''; }
  }

  // ---------------------------------------------------------------- Seitenleiste neben Übersicht und Fachseiten

  let seiteAn = false;
  let letzteArt = null;
  function seitenleiste() {
    let s = document.getElementById('rl-seite');
    if (!s) {
      const app = document.getElementById('app');
      const rahmen = document.createElement('div');
      rahmen.className = 'rahmen';
      app.before(rahmen);
      rahmen.appendChild(app);             // main bleibt dasselbe Element, die App behält ihre Referenz
      s = document.createElement('aside');
      s.id = 'rl-seite';
      s.className = 'rl-seite';
      s.setAttribute('aria-label', 'Wochenrangliste');
      rahmen.appendChild(s);
    }
    return s;
  }

  function nachRoute(art) {
    letzteArt = art;
    seiteAn = !!uid && art !== 'thema' && art !== 'rangliste';
    const s = seitenleiste();
    s.hidden = !seiteAn;
    document.body.classList.toggle('mit-seite', seiteAn);
    if (seiteAn) zeichneSeite(s);
  }

  async function zeichneSeite(s) {
    if (!s.firstChild) s.innerHTML = '<div class="rl-karte rl-seitenkarte"><p class="klein muted">Rangliste wird geladen …</p></div>';
    if (!geladen) return;
    await geladen;
    if (!seiteAn) return;
    if (!profil || !profil.sichtbar) {
      s.innerHTML = `<div class="rl-karte rl-seitenkarte">
        <p class="eyebrow">Wochenrangliste</p>
        <p>Vergleiche deine Wochenpunkte mit anderen. Dafür brauchst du ein öffentliches Profil.</p>
        <p class="klein muted">Freiwillig: Andere sehen dann nur Anzeigename, Bild, Level und Wochenpunkte.</p>
        <a class="knopf" href="#/rangliste">Öffentliches Profil anlegen</a></div>`;
      return;
    }
    try {
      if (Date.now() - cache.zeit > 20000) {
        const [liste, vw] = await Promise.all([holeSichtbare(), fs.collection('wochen').doc(vorigeWoche()).get()]);
        cache = { zeit: Date.now(), liste, vorwoche: vw.exists ? vw.data() : null };
      }
    } catch (e) {
      s.innerHTML = '<div class="rl-karte rl-seitenkarte"><p class="klein muted">Rangliste gerade nicht erreichbar.</p></div>';
      return;
    }
    if (!seiteAn) return;
    const w = dieseWoche();
    const liste = cache.liste.map(p => Object.assign({}, p, { punkte: punkteIn(p, w) })).sort((a, b) => b.punkte - a.punkte || a.name.localeCompare(b.name));
    const aufIds = new Set(aufsteiger(liste).map(a => a.uid));
    const platz = p => 1 + liste.filter(x => x.punkte > p.punkte).length;
    const ich = liste.find(p => p.uid === uid);
    const vw = cache.vorwoche;
    const meldung = vw && vw.uids.includes(uid) ? `<p class="rl-seiten-meldung">Aufgestiegen auf Level ${profil.level}</p>` : '';
    s.innerHTML = `<div class="rl-karte rl-seitenkarte">
      <div class="rl-seitenkopf"><p class="eyebrow">Woche ${wochenNr(w)}</p><span class="klein muted">noch ${restzeit()}</span></div>
      ${meldung}
      <ol class="rl-kurz">${liste.map(p => `<li class="${p.uid === uid ? 'ich' : ''}${aufIds.has(p.uid) ? ' auf' : ''}">
        <span class="rl-platz">${platz(p)}.</span>${ava(p)}
        <span class="rl-kurzname">${esc(p.name)}<small>Level ${p.level}</small></span>
        <span class="rl-zahl">${p.punkte}</span></li>`).join('')}</ol>
      <p class="klein muted">${ich && ich.punkte >= ZIEL ? 'Wochenziel geschafft.' : 'Noch ' + (ZIEL - (ich ? ich.punkte : 0)) + ' Punkte bis zum Wochenziel (40).'}
        ${aufIds.size ? 'Grün markiert: würde jetzt aufsteigen.' : ''}</p>
      <a class="rl-mehr klein" href="#/rangliste">Profil und Regeln</a></div>`;
  }

  // ---------------------------------------------------------------- Schnittstelle

  Object.assign(window.WEB, {
    rangliste: app => { zeichne(app); },
    nachRoute,
    geloest,
    nachAnmeldung: user => {
      geladen = start(user);
      geladen.then(() => {
        if (istOffen()) zeichne(ziel);
        if (letzteArt !== null) nachRoute(letzteArt);
      });
      return geladen;
    },
    loescheProfil: async u => { await profilRef(u).delete(); },
    _test: { wocheVon, aufsteiger, punkteIn },
  });
})();

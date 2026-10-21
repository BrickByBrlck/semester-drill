// Web-Version: Anmeldung mit Google und Speichern in Firestore.
// build.py --web setzt dieses Skript zwischen das Firebase-SDK und die App. Die App wartet auf
// WEB.anmeldung() und bekommt eine Datenbank mit derselben Schnittstelle wie window.claude.use('db'):
// doc('stand/themen'), doc('versuche/<datum>') mit get/set/update. Alles liegt unter nutzer/<uid>/,
// die Regeln in firestore.rules erlauben nur dem Konto selbst den Zugriff.
(function () {
  'use strict';
  const KONFIG = window.WEB_KONFIG;
  firebase.initializeApp(KONFIG.firebase);
  const auth = firebase.auth();
  const fs = firebase.firestore();
  fs.settings({ ignoreUndefinedProperties: true });
  const google = new firebase.auth.GoogleAuthProvider();
  google.setCustomParameters({ prompt: 'select_account' });

  document.body.classList.add('abgemeldet');   // App verdeckt, bis feststeht, wer angemeldet ist

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function dbFuer(uid) {
    const basis = fs.collection('nutzer').doc(uid);
    const ref = pfad => { const [sammlung, id] = pfad.split('/'); return basis.collection(sammlung).doc(id); };
    return {
      doc(pfad) {
        const r = ref(pfad);
        return {
          async get() { const s = await r.get(); return { exists: s.exists, data: () => s.data() }; },
          set: d => r.set(d),
          update: d => r.update(d),
        };
      },
    };
  }

  // ---------------------------------------------------------------- Anmeldeseite

  function zeigeAnmeldung(fehler) {
    document.body.classList.add('abgemeldet');
    let el = document.getElementById('anmeldung');
    if (!el) {
      el = document.createElement('div');
      el.id = 'anmeldung';
      el.className = 'anmeldung';
      document.body.appendChild(el);
    }
    el.innerHTML = `<div class="anmeldung-karte">
      <p class="eyebrow">Physik · 1. Semester · RWTH</p>
      <h1>Semester-Drill</h1>
      <p>Übungsaufgaben zu HM1, EX1 und MMP1 in vier Stufen, von der ersten Formel bis zum Klausurniveau.
        Jede Aufgabe wird sofort geprüft, mit Hinweis auf den typischen Fehler.</p>
      <ul>
        <li><strong>Übungsblätter:</strong> Aufgaben zum Stoff des aktuellen Blatts, mit eigenen Zahlen.</li>
        <li><strong>Klausurtraining:</strong> Aufgabentypen aus Altklausuren mit eigenen Zahlen.</li>
        <li><strong>Dein Stand wird automatisch gespeichert</strong> und ist auf jedem Gerät da, auf dem du dich anmeldest.</li>
      </ul>
      <button type="button" class="google" id="google-anmelden">Mit Google anmelden</button>
      ${fehler ? `<p class="anmeldung-fehler" role="alert">${esc(fehler)}</p>` : ''}
      <p class="klein">Mit der Anmeldung wird dein Lernstand in deinem Konto gespeichert, siehe
        <a href="datenschutz.html">Datenschutz</a>. Inoffizielles Lernprojekt eines Studenten, nicht von der RWTH.
        Die Aufgaben sind selbst erstellt und nachgerechnet, trotzdem ohne Gewähr.</p>
    </div>`;
    el.querySelector('#google-anmelden').addEventListener('click', anmelden);
  }

  const FEHLER = {
    'auth/popup-blocked': 'Der Browser hat das Anmeldefenster blockiert. Erlaube Pop-ups für diese Seite und versuch es noch einmal.',
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
    'auth/network-request-failed': 'Keine Verbindung. Prüf dein Internet und versuch es noch einmal.',
    'auth/unauthorized-domain': 'Diese Adresse ist in Firebase noch nicht freigegeben (Authentication → Autorisierte Domains).',
  };

  async function anmelden() {
    const knopf = document.getElementById('google-anmelden');
    knopf.disabled = true;
    knopf.textContent = 'Anmeldefenster ist offen …';
    try {
      await auth.signInWithPopup(google);
    } catch (e) {
      const text = e && e.code in FEHLER ? FEHLER[e.code] : 'Anmeldung fehlgeschlagen' + (e && e.code ? ' (' + e.code + ')' : '') + '.';
      zeigeAnmeldung(text);
    }
  }

  // ---------------------------------------------------------------- Konto in der Kopfleiste

  function zeigeKonto(user) {
    document.body.classList.remove('abgemeldet');
    const anm = document.getElementById('anmeldung');
    if (anm) anm.remove();
    const leiste = document.querySelector('.leiste');
    let k = document.getElementById('konto');
    if (!k) {
      k = document.createElement('details');
      k.id = 'konto';
      k.className = 'konto';
      leiste.appendChild(k);
    }
    const name = user.displayName || user.email || 'Konto';
    k.innerHTML = `<summary aria-label="Konto">${esc(name.trim().charAt(0).toUpperCase())}</summary>
      <div class="konto-menue">
        <p><strong>${esc(name)}</strong>${user.email && user.email !== name ? `<br><small>${esc(user.email)}</small>` : ''}</p>
        <p class="klein">Dein Stand wird nach jeder Aufgabe gespeichert.</p>
        <button type="button" data-k="ab">Abmelden</button>
        <a href="datenschutz.html">Datenschutz</a>
        <button type="button" data-k="loeschen" class="gefahr">Konto und Lernstand löschen</button>
      </div>`;
    k.querySelector('[data-k="ab"]').addEventListener('click', () => auth.signOut());
    k.querySelector('[data-k="loeschen"]').addEventListener('click', loeschen);
  }

  document.addEventListener('click', e => {
    const k = document.getElementById('konto');
    if (k && k.open && !k.contains(e.target)) k.open = false;
  });

  async function loeschen() {
    const user = auth.currentUser;
    if (!user) return;
    if (!window.confirm('Konto und gesamten Lernstand endgültig löschen? Das lässt sich nicht rückgängig machen.')) return;
    try {
      const basis = fs.collection('nutzer').doc(user.uid);
      const versuche = await basis.collection('versuche').get();
      await Promise.all(versuche.docs.map(d => d.ref.delete()));
      await basis.collection('stand').doc('themen').delete();
      await basis.collection('stand').doc('einstellungen').delete();
      if (window.WEB.loescheProfil) await window.WEB.loescheProfil(user.uid);
      try {
        await user.delete();
      } catch (e) {
        if (!e || e.code !== 'auth/requires-recent-login') throw e;
        await user.reauthenticateWithPopup(google);   // Firebase verlangt eine frische Anmeldung zum Löschen
        await user.delete();
      }
      try {
        for (const s of Object.keys(localStorage)) if (s.endsWith('-' + user.uid)) localStorage.removeItem(s);
      } catch (e) { /* ohne Speicher nichts zu tun */ }
      window.alert('Dein Konto und dein Lernstand sind gelöscht.');
      window.location.reload();
    } catch (e) {
      window.alert('Löschen fehlgeschlagen' + (e && e.code ? ' (' + e.code + ')' : '') + '. Versuch es noch einmal oder schreib mir.');
    }
  }

  // ---------------------------------------------------------------- Fußzeile

  function fusszeile() {
    const f = document.createElement('footer');
    f.className = 'fuss';
    const kontakt = KONFIG.kontakt ? ` Fehler gefunden? <a href="mailto:${esc(KONFIG.kontakt)}">Schreib mir</a>.` : '';
    f.innerHTML = `Inoffizielles Lernprojekt, nicht von der RWTH. Aufgaben selbst erstellt und nachgerechnet, trotzdem ohne Gewähr.${kontakt}
      · <a href="datenschutz.html">Datenschutz</a>`;
    document.body.appendChild(f);
  }

  // ---------------------------------------------------------------- Schnittstelle für die App

  let warten = [];
  let erster = true;
  auth.onAuthStateChanged(user => {
    if (user) {
      zeigeKonto(user);
      const k = { uid: user.uid, db: dbFuer(user.uid) };
      if (window.WEB.nachAnmeldung) window.WEB.nachAnmeldung(user);
      warten.forEach(w => w(k));
      warten = [];
    } else if (erster) {
      zeigeAnmeldung();
    } else {
      window.location.reload();              // abgemeldet: frisch starten, damit kein fremder Stand im Speicher bleibt
    }
    erster = false;
  });

  window.WEB = {
    anmeldung: () => new Promise(r => {
      if (auth.currentUser) r({ uid: auth.currentUser.uid, db: dbFuer(auth.currentUser.uid) });
      else warten.push(r);
    }),
    intern: { fs, auth },      // für rangliste.js
  };

  document.addEventListener('DOMContentLoaded', fusszeile);
  if (document.readyState !== 'loading') fusszeile();
})();

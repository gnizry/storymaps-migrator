(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const cfg = window.MIGRATOR_CONFIG || {};
  let session = null, currentTour = null, currentItem = null;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function renderAuth() {
    $("who").textContent = session ? `מחובר: ${session.fullName || session.username}` : "";
    $("signin").hidden = !!session;
    $("signout").hidden = !session;
    $("create").disabled = !session || !currentTour;
    $("create").title = session ? "" : "יש להתחבר קודם";
  }

  function download(name, obj) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function scan() {
    const id = $("src").value.trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) { alert("מזהה לא תקין (32 תווים)"); return; }
    $("list").innerHTML = `<tr><td colspan="5" class="muted">טוען...</td></tr>`;
    $("listCard").hidden = false;
    try {
      const items = await Migrator.listSource(id);
      $("list").innerHTML = "";
      for (const it of items) {
        const c = Migrator.classify(it);
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${esc(it.title)}<div class="muted" dir="ltr">${esc(it.id)}</div></td>
          <td><span class="tag ${c.auto ? "auto" : ""}">${esc(c.label)}</span></td>
          <td>${esc(c.target)}${c.auto ? "" : (c.key === "new" ? "" : '<div class="muted">הגירה אוטומטית בהמשך</div>')}</td>
          <td>${(it.numViews || 0).toLocaleString("he-IL")}</td>
          <td class="row"></td>`;
        const actions = tr.lastElementChild;
        if (c.auto) {
          const b = document.createElement("button"); b.textContent = "תצוגה מקדימה"; b.className = "primary";
          b.onclick = () => preview(it); actions.appendChild(b);
        }
        const d = document.createElement("button"); d.textContent = "גיבוי JSON";
        d.onclick = async () => download(`${it.id}_data.json`, { item: it, data: await Migrator.itemData(it.id).catch((e) => ({ error: String(e) })) });
        actions.appendChild(d);
        $("list").appendChild(tr);
      }
      if (!items.length) $("list").innerHTML = `<tr><td colspan="5" class="muted">לא נמצאו פריטים</td></tr>`;
    } catch (e) {
      $("list").innerHTML = `<tr><td colspan="5" class="err">${esc(e.message)}</td></tr>`;
    }
  }

  async function preview(item) {
    currentItem = item; currentTour = null;
    $("previewCard").hidden = false;
    $("pvTitle").textContent = item.title;
    $("pvMeta").textContent = "קורא את הסיור...";
    $("pvWarn").textContent = ""; $("log").textContent = ""; $("places").innerHTML = "";
    renderAuth();
    try {
      const t = await Migrator.extractMapTour(item.id);
      currentTour = t;
      $("pvMeta").textContent = `${t.places.length} נקודות · כותרת: ${t.title}${t.subtitle ? " · " + t.subtitle : ""}`;
      $("coverSel").innerHTML = `<option value="-1">ללא תמונה (שער פשוט)</option>` + t.places.map((p, i) => (p.media && p.mediaKind === "image") ? `<option value="${i}">${i + 1}. ${esc(p.name)}</option>` : "").join("");
      $("coverSel").value = t.places.findIndex((p) => p.media && p.mediaKind === "image");
      $("pvWarn").innerHTML = t.warnings.map(esc).join("<br>");
      $("places").innerHTML = t.places.map((p, i) => `<div class="place">${p.media && p.mediaKind === "image" ? `<img loading="lazy" src="${esc(p.media)}" alt="">` : ""}
        <div><strong>${i + 1}. ${esc(p.name)}</strong><br>${esc((p.paragraphs.join(" ").replace(/<[^>]+>/g, "")).slice(0, 140))}</div></div>`).join("");
      $("previewCard").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      $("pvMeta").innerHTML = `<span class="err">${esc(e.message)}</span>`;
    }
    renderAuth();
  }

  async function create() {
    if (!session || !currentTour) return;
    $("create").disabled = true;
    const log = (m) => ($("log").textContent += m + "\n");
    try {
      const r = await Migrator.migrateMapTour(session, currentTour, log, { themeItemId: cfg.themeItemId, byline: cfg.byline, coverPlace: parseInt($("coverSel").value, 10), intro: $("introChk").checked });
      $("log").innerHTML += `נוצרה טיוטה עם ${r.count} נקודות. <a href="${esc(r.editUrl)}" target="_blank" rel="noopener">פתח בעורך StoryMaps</a>\n`;
    } catch (e) {
      log("שגיאה: " + e.message);
    }
    renderAuth();
  }

  $("scan").onclick = scan;
  $("src").addEventListener("keydown", (e) => { if (e.key === "Enter") scan(); });
  $("create").onclick = create;
  $("dl").onclick = () => currentTour && download(`${currentTour.appId}_places.json`, currentTour);
  $("signin").onclick = () => { $("lerr").textContent = ""; $("loginDlg").showModal(); $("lu").focus(); };
  $("lcancel").onclick = () => $("loginDlg").close();
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("lgo").disabled = true; $("lerr").textContent = "";
    try {
      session = await Auth.signInWithPassword($("lu").value.trim(), $("lp").value);
      $("lp").value = "";
      $("loginDlg").close();
      renderAuth();
    } catch (err) { $("lerr").textContent = err.message; }
    $("lgo").disabled = false;
  });
  $("signout").onclick = () => { Auth.signOut(); session = null; renderAuth(); };

  (async function init() {
    $("src").value = new URLSearchParams(location.search).get("source") || cfg.defaultSource || "";
    try { session = (await Auth.handleRedirect()) || Auth.current(); } catch (e) { alert(e.message); }
    renderAuth();
    if ($("src").value) scan();
  })();
})();

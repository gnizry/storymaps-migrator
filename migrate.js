// Core logic: read classic story maps and build new ArcGIS StoryMaps drafts.
// No UI code here, so it can be unit-tested in Node.
(function (root) {
  "use strict";

  const SHARING = "https://www.arcgis.com/sharing/rest";

  const FIELD_ALIASES = {
    name: ["name", "title"],
    caption: ["caption", "description", "desc"],
    pic: ["url", "pic_url", "picture", "image", "media"],
    lon: ["long", "lon", "longitude"],
    lat: ["lat", "latitude"],
  };

  // ------------------------------------------------------------------ http
  let fetchImpl = (typeof fetch !== "undefined") ? fetch.bind(root) : null;
  function setFetch(f) { fetchImpl = f; }

  async function getJSON(url, params) {
    const q = new URLSearchParams(Object.assign({ f: "json" }, params || {}));
    const r = await fetchImpl(url + (url.includes("?") ? "&" : "?") + q.toString());
    const j = await r.json();
    if (j && j.error) throw new Error(url + ": " + (j.error.message || JSON.stringify(j.error)));
    return j;
  }

  async function postForm(url, fields, token) {
    const fd = new FormData();
    fd.append("f", "json");
    if (token) fd.append("token", token);
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      if (v && v.blob) fd.append(k, v.blob, v.filename);
      else fd.append(k, typeof v === "string" ? v : JSON.stringify(v));
    }
    const r = await fetchImpl(url, { method: "POST", body: fd });
    const j = await r.json();
    if (j && j.error) throw new Error(url + ": " + (j.error.message || JSON.stringify(j.error)));
    if (j && j.success === false) throw new Error(url + ": request failed");
    return j;
  }

  const itemInfo = (id) => getJSON(`${SHARING}/content/items/${id}`);
  const itemData = (id) => getJSON(`${SHARING}/content/items/${id}/data`);

  // ------------------------------------------------------------------ classify
  function classify(item) {
    const kw = (item.typeKeywords || []).map((k) => k.toLowerCase());
    const url = (item.url || "").toLowerCase();
    const has = (s) => kw.includes(s) || url.includes("/" + s + "/");
    if (item.type === "StoryMap") return { key: "new", label: "StoryMap חדש", target: "כבר בפורמט החדש" };
    if (has("maptour")) return { key: "maptour", label: "Map Tour", target: "Story + Guided Map Tour", auto: true };
    if (has("mapjournal")) return { key: "mapjournal", label: "Map Journal", target: "Story + Sidecar" };
    if (has("mapseries")) return { key: "mapseries", label: "Map Series", target: "Story / Briefing" };
    if (has("cascade")) return { key: "cascade", label: "Cascade", target: "Story + Immersive" };
    if (has("shortlist")) return { key: "shortlist", label: "Shortlist", target: "Story + Explorer Map Tour" };
    if (kw.includes("swipespyglass") || url.includes("storytellingswipe")) return { key: "swipe", label: "Swipe", target: "Story + Swipe" };
    if (url.includes("/elevations/")) return { key: "app", label: "Elevation Profile", target: "Instant App / Experience Builder" };
    if (url.includes("/onepane/")) return { key: "app", label: "OnePane", target: "Instant App" };
    if (item.type === "Web Mapping Application") return { key: "app", label: "אפליקציה", target: "Instant App / Experience Builder" };
    return { key: "other", label: item.type, target: "" };
  }

  // Accepts an item id of a gallery app, a group id, or a single item
  async function listSource(id) {
    let groupId = null;
    try {
      const g = await getJSON(`${SHARING}/community/groups/${id}`);
      if (g && g.id) groupId = g.id;
    } catch (e) { /* not a group */ }
    if (!groupId) {
      const info = await itemInfo(id);
      if (info.type === "Web Mapping Application") {
        const d = await itemData(id).catch(() => ({}));
        const v = (d && d.values) || {};
        if (v.group) groupId = v.group;
        else return [info];
      } else return [info];
    }
    let all = [], start = 1;
    while (start > 0) {
      const r = await getJSON(`${SHARING}/content/groups/${groupId}/search`, { q: "*", num: 100, start });
      all = all.concat(r.results || []);
      start = r.nextStart;
    }
    return all;
  }

  // ------------------------------------------------------------------ helpers
  function pick(attrs, key) {
    const lower = {};
    Object.keys(attrs).forEach((k) => (lower[k.toLowerCase()] = k));
    for (const c of FIELD_ALIASES[key]) if (c in lower) return attrs[lower[c]];
    return null;
  }
  const R = 6378137.0;
  function mercToLonLat(x, y) {
    return [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
  }
  function lonLatToMerc(lon, lat) {
    return [lon * Math.PI / 180 * R, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R];
  }
  function cleanMedia(u) {
    if (!u) return null;
    u = String(u).trim();
    if (!u) return null;
    const flagged = u.includes("#isVideo");
    u = u.replace(/#is(Image|Video)$/, "").replace(/^\/\//, "https://").replace(/^http:\/\//, "https://");
    const yt = u.match(/(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{6,})/i);
    if (yt) return { url: "https://www.youtube.com/embed/" + yt[1], kind: "video" };
    const vm = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
    if (vm) return { url: "https://player.vimeo.com/video/" + vm[1], kind: "video" };
    return { url: u, kind: flagged || /\.(mp4|webm|mov)(\?|$)/i.test(u) ? "video" : "image" };
  }
  function captionToParagraphs(c) {
    if (!c) return [];
    c = String(c).replace(/\r/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d)>/gi, "\n")
      .replace(/<(p|div|li|h\d|ul|ol|span|font)[^>]*>/gi, "")
      .replace(/<\/(ul|ol|span|font)>/gi, "")
      .replace(/<b>/gi, "<strong>").replace(/<\/b>/gi, "</strong>")
      .replace(/<i>/gi, "<em>").replace(/<\/i>/gi, "</em>")
      .replace(/&nbsp;/g, " ");
    return c.split("\n").map((p) => p.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
  }
  function stripTags(s) {
    return String(s || "").replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
  }
  const isHebrew = (s) => /[֐-׿]/.test(s || "");
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const nid = () => "n-" + hex(6);
  const rid = () => "r-" + hex(6);
  const uuid = () => (root.crypto && root.crypto.randomUUID) ? root.crypto.randomUUID()
    : `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;

  // ------------------------------------------------------------------ Map Tour extraction
  async function extractMapTour(appId) {
    const info = await itemInfo(appId);
    const data = await itemData(appId);
    const v = data.values || {};
    if (!v.webmap) throw new Error("לפריט אין מפת רשת. האם זה Map Tour?");
    const wm = await itemData(v.webmap);
    const src = v.sourceLayer || "";
    const layers = wm.operationalLayers || [];
    const matches = (l) => src && (src === l.id || src.startsWith(l.id) || (l.id || "").startsWith(src));
    let tl = layers.find(matches) || layers.find((l) => l.featureCollection);
    if (!tl) throw new Error("לא נמצאה שכבת נקודות הסיור במפה");

    let features = [];
    if (tl.featureCollection) {
      (tl.featureCollection.layers || []).forEach((fl) => (features = features.concat((fl.featureSet || {}).features || [])));
    } else if (tl.url) {
      const q = await getJSON(tl.url.replace(/\/$/, "") + "/query", { where: "1=1", outFields: "*", returnGeometry: "true", outSR: "4326" });
      features = (q.features || []).map((f) => { f.geometry = Object.assign({}, f.geometry, { _wgs84: true }); return f; });
    } else throw new Error("סוג שכבת סיור לא נתמך");

    const oid = (f) => { const a = f.attributes; for (const k of ["__OBJECTID", "OBJECTID", "ObjectId", "FID", "objectid"]) if (k in a) return a[k]; return null; };
    const byId = new Map(features.map((f) => [oid(f), f]));
    const ordered = v.order ? v.order.filter((o) => o.visible !== false && byId.has(o.id)).map((o) => byId.get(o.id)) : features;

    const warnings = [];
    const places = ordered.map((f) => {
      const a = f.attributes, g = f.geometry || {};
      let lon = parseFloat(pick(a, "lon")), lat = parseFloat(pick(a, "lat"));
      if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) {
        lon = lat = null;
        if (g.x !== undefined && g.y !== undefined) {
          const gx = parseFloat(g.x), gy = parseFloat(g.y);
          const wkid = (g.spatialReference || {}).wkid;
          if (g._wgs84 || wkid === 4326 || (Math.abs(gx) <= 180 && Math.abs(gy) <= 90)) { lon = gx; lat = gy; }
          else [lon, lat] = mercToLonLat(gx, gy);
        }
      }
      const name = stripTags(pick(a, "name"));
      const media = cleanMedia(pick(a, "pic"));
      if (lon === null) warnings.push(`"${name}": אין מיקום - הנקודה לא תיכלל`);
      return { name, paragraphs: captionToParagraphs(pick(a, "caption")), media: media && media.url, mediaKind: media && media.kind, lon, lat };
    });

    return {
      appId,
      title: v.title || info.title,
      subtitle: v.subtitle || info.snippet || "",
      itemTitle: info.title,
      tags: info.tags || [],
      firstRecordAsIntro: !!v.firstRecordAsIntro,
      webmapId: v.webmap,
      basemap: wm.baseMap,
      spatialReference: wm.spatialReference || { wkid: 102100 },
      referenceLayers: layers.filter((l) => l !== tl && l.url && !l.featureCollection),
      places,
      warnings,
    };
  }

  // ------------------------------------------------------------------ story JSON
  function newStoryTemplate(byline, locale, themeItemId) {
    const rootId = nid(), cover = nid(), nav = nid(), credits = nid(), theme = rid();
    return {
      root: rootId,
      nodes: {
        [rootId]: { type: "story", data: { storyTheme: theme }, config: { coverDate: "first-published", storyLocale: locale || "en-US" }, children: [cover, nav, credits] },
        [cover]: { type: "storycover", data: { type: "minimal", title: "", summary: "", byline: byline || "", titlePanelPosition: "start" } },
        [nav]: { type: "navigation", data: { links: [] }, config: { isHidden: true } },
        [credits]: { type: "credits" },
      },
      resources: { [theme]: { type: "story-theme", data: Object.assign({ themeId: "summit", themeBaseVariableOverrides: {} }, themeItemId ? { themeItemId } : {}) } },
    };
  }

  // Cover: a full-bleed image (when given) with the title panel centered over a gradient.
  // image: { url, width, height } or null for a plain minimal cover.
  function setCover(props, title, summary, image) {
    for (const [id, n] of Object.entries(props.nodes)) {
      if (n.type !== "storycover") continue;
      n.data.title = title; n.data.summary = summary;
      if (image && image.url) {
        const ir = rid(), img = nid();
        props.resources[ir] = { type: "image", data: Object.assign({ src: image.url, provider: "uri" }, image.width ? { width: image.width, height: image.height } : {}) };
        props.nodes[img] = { type: "image", data: { image: ir } };
        Object.assign(n.data, { type: "full", titlePanelVerticalPosition: "middle", titlePanelHorizontalPosition: "center", titlePanelStyle: "gradient" });
        delete n.data.titlePanelPosition;
        n.children = [img];
      }
    }
  }

  function addTour(props, tour, basemapWebmapId, introParagraphs, introNodes, zoomScale) {
    const nodes = props.nodes, res = props.resources;
    const basemapRes = rid();
    res[basemapRes] = { type: "webmap", data: { type: "minimal", itemType: "Web Map", itemId: basemapWebmapId } };
    const geometries = {}, places = [];
    for (const p of tour.places) {
      if (p.lon === null || p.lon === undefined) continue;
      const fid = uuid();
      const [x, y] = lonLatToMerc(p.lon, p.lat);
      geometries[fid] = { id: fid, type: "POINT_NUMBERED_TOUR", nodes: [{ long: p.lon, lat: p.lat, proX: x, proY: y }] };
      if (zoomScale) geometries[fid].scale = zoomScale; // per-place map scale (1:N); without it the tour map stays very zoomed out
      const titleId = nid();
      nodes[titleId] = { type: "text", data: { text: p.name, type: "h3" } };
      const paras = p.paragraphs.slice();
      const contents = paras.map((t) => { const id = nid(); nodes[id] = { type: "text", data: { text: t, type: "paragraph" } }; return id; });
      const place = { id: nid(), featureId: fid, contents, title: titleId };
      if (p.media && p.mediaKind === "video") {
        // YouTube / Vimeo (or any embeddable video URL) as an embed node inside the carousel
        const emb = nid(), car = nid();
        nodes[emb] = { type: "embed", data: { url: p.media, embedType: "video", caption: "", alt: "", display: "inline", aspectRatio: 1.778, addedAsEmbedCode: true } };
        nodes[car] = { type: "carousel", children: [emb] };
        place.media = car;
      } else if (p.media && p.mediaKind === "image") {
        const ir = rid(), img = nid(), car = nid();
        res[ir] = { type: "image", data: { src: p.media, provider: "uri" } };
        if (p.width && p.height) { res[ir].data.width = p.width; res[ir].data.height = p.height; }
        // placement.fill is required: the StoryMaps editor refuses to open a draft without it
        nodes[img] = { type: "image", data: { image: ir }, config: { placement: { type: "fit", fill: { x: 0.5, y: 0.5 }, fit: { color: "backgroundColor" } } } };
        nodes[car] = { type: "carousel", children: [img] };
        place.media = car;
      }
      places.push(place);
    }
    const mapId = nid(), tourId = nid();
    nodes[mapId] = { type: "tour-map", data: { geometries, alt: "", basemap: { type: "resource", value: basemapRes } } };
    nodes[tourId] = { type: "tour", data: { type: "guided-tour", subtype: "media-focused", narrativePanelPosition: isHebrew(tour.title) ? "end" : "start", narrativePanelSize: "small", accentColor: "accentColor1", map: mapId, places } };
    const added = (introNodes || []).map((n) => { const id = nid(); nodes[id] = { type: "text", data: { text: n.text, type: n.type } }; return id; });
    (introParagraphs || []).forEach((t) => { const id = nid(); nodes[id] = { type: "text", data: { text: t, type: "paragraph" } }; added.push(id); });
    added.push(tourId);
    const children = nodes[props.root].children;
    let at = children.findIndex((c) => (nodes[c] || {}).type === "credits");
    if (at < 0) at = children.length;
    children.splice(at, 0, ...added);
    return places.length;
  }

  // Short "how to use this tour" opening shown between the cover and the tour.
  function introParagraphs(tour, count) {
    if (isHebrew(tour.title)) {
      return [
        { type: "h2", text: "איך מטיילים בסיור?" },
        { type: "paragraph", text: `זהו סיור אינטראקטיבי בן ${count} תחנות. בכל תחנה מוצגים תמונה והסבר, והמקום מסומן על המפה.` },
        { type: "bullet-list", text: "<li>עברו בין התחנות בעזרת החצים, או בלחיצה על הנקודות הממוספרות במפה.</li><li>אפשר להגדיל, להקטין ולהזיז את המפה בכל רגע.</li><li>גללו מטה כדי להתחיל בסיור.</li>" },
      ];
    }
    return [
      { type: "h2", text: "How to take the tour" },
      { type: "paragraph", text: `This interactive tour has ${count} stops. Each stop has a photo and a short description, and its location is marked on the map.` },
      { type: "bullet-list", text: "<li>Move between stops with the arrows, or click a numbered point on the map.</li><li>You can zoom and pan the map at any time.</li><li>Scroll down to start the tour.</li>" },
    ];
  }

  // opts: { byline, themeItemId, coverPlace (0-based index of the place whose image is the cover, or -1 for none) }
  function buildTourStory(tour, basemapWebmapId, opts) {
    opts = typeof opts === "string" ? { byline: opts } : (opts || {});
    let t = tour, intro = null;
    if (tour.firstRecordAsIntro && tour.places.length) { intro = tour.places[0].paragraphs; t = Object.assign({}, tour, { places: tour.places.slice(1) }); }
    const props = newStoryTemplate(opts.byline, isHebrew(tour.title) ? "he" : "en-US", opts.themeItemId);
    const cp = opts.coverPlace === undefined ? 0 : opts.coverPlace;
    const cpl = cp >= 0 ? tour.places[cp] : null;
    const image = cpl && cpl.media && cpl.mediaKind === "image" ? { url: cpl.media, width: cpl.width, height: cpl.height } : null;
    setCover(props, tour.title, tour.subtitle, image);
    props.nodes[props.root].config.coverDate = "none";
    const introNodes = opts.intro === false ? [] : introParagraphs(tour, t.places.filter((p) => p.lon !== null && p.lon !== undefined).length);
    const count = addTour(props, t, basemapWebmapId, intro, introNodes, opts.zoomScale === undefined ? 3000 : opts.zoomScale);
    return { props, count };
  }

  // ------------------------------------------------------------------ writing to ArcGIS Online
  async function storymapsVersion() {
    try { const r = await fetchImpl("https://storymaps.arcgis.com/version?f=json"); const j = await r.json(); if (j.version) return j.version; } catch (e) { /* ignore */ }
    return "24.12";
  }

  // session: { portal: "https://org.maps.arcgis.com", token, username }
  // Imagery underneath, light gray canvas on top that fades out when zoomed in: gray when far, aerial photo when close.
  const GRAY_IMAGERY_BASEMAP = {
    title: "Light gray + imagery",
    baseMapLayers: [
      { id: "worldImagery", title: "World Imagery", layerType: "ArcGISTiledMapServiceLayer", url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer", visibility: true, opacity: 1 },
      { id: "lightGray", title: "Light Gray Canvas", layerType: "ArcGISTiledMapServiceLayer", url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer", visibility: true, opacity: 1, minScale: 0, maxScale: 150000 },
      { id: "lightGrayRef", title: "Light Gray Reference", layerType: "ArcGISTiledMapServiceLayer", url: "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer", visibility: true, opacity: 1, isReference: true, minScale: 0, maxScale: 150000 },
    ],
  };
  async function createBasemapWebmap(session, tour) {
    const wm = { operationalLayers: tour.referenceLayers, baseMap: GRAY_IMAGERY_BASEMAP, spatialReference: tour.spatialReference, version: "2.31", authoringApp: "storymaps-migrator", authoringAppVersion: "1" };
    const r = await postForm(`${session.portal}/sharing/rest/content/users/${encodeURIComponent(session.username)}/addItem`, {
      type: "Web Map", title: `${tour.itemTitle} - ${isHebrew(tour.itemTitle) ? "מפת בסיס לסיור" : "tour basemap"} (StoryMaps)`, tags: ["StoryMaps migration"].concat(tour.tags).join(","),
      snippet: `Basemap for the migrated tour of classic app ${tour.appId}`, text: JSON.stringify(wm),
    }, session.token);
    return r.id;
  }

  async function createStoryDraft(session, title, tags, props) {
    const ver = await storymapsVersion();
    const draft = `draft_${Date.now()}.json`;
    const keywords = ["arcgis-storymaps", "StoryMap", "Web Application", "smstatusdraft", `smversiondraft:${ver}`,
      "smeditorapp:storymaps-migrator", `smdraftresourceid:${draft}`].join(",");
    const base = `${session.portal}/sharing/rest/content/users/${encodeURIComponent(session.username)}`;
    const add = await postForm(`${base}/addItem`, {
      type: "StoryMap", title, typeKeywords: keywords, tags: tags.join(","), text: " ",
      thumbnailurl: "https://storymaps.arcgis.com/static/images/item-default-thumbnails/item.jpg",
    }, session.token);
    const id = add.id;
    const blob = new Blob([JSON.stringify(props)], { type: "application/json" });
    await postForm(`${base}/items/${id}/addResources`, {
      file: { blob, filename: draft }, fileName: draft, access: "private",
      properties: { editInfo: { editor: session.username, modified: String(Date.now()), id: hex(21), app: "storymaps-migrator" } },
    }, session.token);
    return id;
  }

  function imageSize(url) {
    return new Promise((resolve) => {
      if (typeof Image === "undefined") return resolve(null);
      const im = new Image();
      const timer = setTimeout(() => resolve(null), 8000);
      im.onload = () => { clearTimeout(timer); resolve(im.naturalWidth ? { width: im.naturalWidth, height: im.naturalHeight } : null); };
      im.onerror = () => { clearTimeout(timer); resolve(null); };
      im.src = url;
    });
  }

  async function migrateMapTour(session, tour, log, opts) {
    opts = opts || {};
    log("בודק גדלי תמונות...");
    await Promise.all(tour.places.map(async (p) => {
      if (p.media && p.mediaKind === "image") { const sz = await imageSize(p.media); if (sz) Object.assign(p, sz); }
    }));
    log("יוצר מפת בסיס...");
    const wmId = await createBasemapWebmap(session, tour);
    log("מפת בסיס: " + wmId);
    const { props, count } = buildTourStory(tour, wmId, { byline: opts.byline || session.username, themeItemId: opts.themeItemId, coverPlace: opts.coverPlace, intro: opts.intro, zoomScale: opts.zoomScale });
    log(`בונה סיפור עם ${count} נקודות...`);
    const id = await createStoryDraft(session, tour.title, ["StoryMaps migration"].concat(tour.tags), props);
    return { storyId: id, webmapId: wmId, count, editUrl: `https://storymaps.arcgis.com/stories/${id}/edit` };
  }


  // ------------------------------------------------------------------ Map Journal (classic) -> story
  const escHtml = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const httpsUrl = (u) => String(u || "").trim().replace(/^\/\//, "https://").replace(/^http:\/\//i, "https://");
  const plain = (h) => stripTags(String(h || "").replace(/<br\s*\/?>/gi, " ")).replace(/&nbsp;| /g, " ").replace(/\s+/g, " ").trim();

  // Classic rich-text HTML -> flat list of blocks (paragraphs, lists, headings, images). Needs DOMParser (browser).
  function htmlToBlocks(html) {
    const doc = new DOMParser().parseFromString("<body>" + String(html || "") + "</body>", "text/html");
    const blocks = [];
    let buf = "", bufActs = [];
    const INLINE = new Set(["SPAN", "STRONG", "B", "EM", "I", "U", "A", "FONT", "BR", "SUP", "SUB", "SMALL", "MARK", "CODE"]);
    const BLOCKY = "img,iframe,ul,ol,figure,p,div,h1,h2,h3,h4,h5,h6,table,blockquote";
    function inline(n, acts) {
      if (n.nodeType === 3) return escHtml(n.nodeValue.replace(/ /g, " "));
      if (n.nodeType !== 1) return "";
      const tag = n.tagName;
      if (tag === "BR") return " ";
      if (tag === "IMG" || tag === "IFRAME") return "";
      const inner = Array.from(n.childNodes).map((c) => inline(c, acts)).join("");
      if (tag === "STRONG" || tag === "B") return inner.trim() ? `<strong>${inner}</strong>` : inner;
      if (tag === "EM" || tag === "I") return inner.trim() ? `<em>${inner}</em>` : inner;
      if (tag === "A") {
        const act = n.getAttribute("data-storymaps");
        if (act) { acts.push(act); return inner; }
        const href = httpsUrl(n.getAttribute("href"));
        return /^https?:\/\//.test(href) && inner.trim() ? `<a href="${escHtml(href)}">${inner}</a>` : inner;
      }
      return inner;
    }
    const empty = (h) => !plain(h);
    function flush() { if (!empty(buf)) blocks.push({ type: "p", html: buf.replace(/\s+/g, " ").trim(), acts: bufActs }); buf = ""; bufActs = []; }
    function image(img, caption) {
      const src = httpsUrl(img.getAttribute("src"));
      if (src) blocks.push({ type: "image", src, caption: caption || "", alt: img.getAttribute("alt") || "" });
    }
    function walk(el) {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3) { buf += escHtml(n.nodeValue.replace(/ /g, " ")); continue; }
        if (n.nodeType !== 1) continue;
        const tag = n.tagName;
        if (INLINE.has(tag) && !n.querySelector(BLOCKY)) { buf += inline(n, bufActs); continue; }
        flush();
        if (tag === "IMG") image(n, "");
        else if (tag === "IFRAME") { const u = httpsUrl(n.getAttribute("src")); if (u) blocks.push({ type: "embed", url: u }); }
        else if (tag === "FIGURE") {
          const cap = plain((n.querySelector("figcaption") || {}).innerHTML || "");
          const imgs = Array.from(n.querySelectorAll("img"));
          if (imgs.length) imgs.forEach((im) => image(im, cap));
          else { const c = n.cloneNode(true); const fc = c.querySelector("figcaption"); if (fc) fc.remove(); walk(c); flush(); }
        } else if (tag === "UL" || tag === "OL") {
          const lis = Array.from(n.children).filter((x) => x.tagName === "LI").map((li) => { const a = []; return inline(li, a).replace(/\s+/g, " ").trim(); }).filter((h) => !empty(h));
          if (lis.length) blocks.push({ type: tag === "UL" ? "ul" : "ol", html: lis.map((h) => `<li>${h}</li>`).join("") });
        } else if (/^H[1-6]$/.test(tag)) {
          const a = []; const h = inline(n, a).replace(/\s+/g, " ").trim(); if (!empty(h)) blocks.push({ type: "h", html: plain(h) });
        } else if (tag === "FIGCAPTION" || tag === "SCRIPT" || tag === "STYLE") { /* skip */ }
        else if (n.querySelector(BLOCKY)) { walk(n); flush(); }
        else { const a = []; const h = inline(n, a).replace(/\s+/g, " ").trim(); if (!empty(h)) blocks.push({ type: "p", html: h, acts: a }); }
      }
    }
    walk(doc.body); flush();
    return blocks;
  }

  const isVideoUrl = (u) => /youtube\.com|youtu\.be|vimeo\.com/i.test(u);
  function videoEmbedUrl(u) {
    const c = cleanMedia(u);
    return c ? c.url : httpsUrl(u);
  }

  async function extractMapJournal(appId) {
    const info = await itemInfo(appId);
    const data = await itemData(appId);
    const v = data.values || {};
    const sections = (v.story && v.story.sections) || [];
    if (!sections.length) throw new Error("לא נמצאו מקטעים. האם זה Map Journal?");
    const warnings = [];
    const out = [];
    sections.forEach((s, i) => {
      if (s.status === "HIDDEN") { warnings.push(`מקטע ${i + 1} (${plain(s.title)}) מוסתר במקור ולא הועבר`); return; }
      const actions = {};
      (s.contentActions || []).forEach((a) => { if (a.type === "media" && a.media) actions[a.id] = a.media; });
      out.push({ title: plain(s.title), html: s.content || "", media: s.media || null, actions });
    });
    return { appId, title: plain(v.title || info.title).replace(/\s*\|\s*/g, " | "), itemTitle: info.title, tags: info.tags || [], sections: out, warnings };
  }

  // media: classic section/action media -> a story node id (or null when unsupported)
  function journalMediaNode(props, media, warnings, label) {
    if (!media || !media.type) return null;
    const nodes = props.nodes, res = props.resources;
    const m = media[media.type] || {};
    const video = (url) => {
      const id = nid();
      nodes[id] = { type: "embed", data: { url: videoEmbedUrl(url), embedType: "video", caption: "", alt: "", display: "inline", aspectRatio: 1.778, addedAsEmbedCode: true }, config: { size: "wide" } };
      return id;
    };
    const link = (url) => {
      const id = nid();
      nodes[id] = { type: "embed", data: { url: httpsUrl(url), embedType: "link", caption: "", alt: "", display: "card" } };
      return id;
    };
    if (media.type === "image" && m.url) {
      const ir = rid(), id = nid();
      res[ir] = { type: "image", data: { src: httpsUrl(m.url), provider: "uri" } };
      nodes[id] = { type: "image", data: { image: ir, caption: m.caption || "", alt: m.altText || "" }, config: { size: "wide", placement: { type: "fit", fill: { x: 0.5, y: 0.5 }, fit: { color: "backgroundColor" } } } };
      return id;
    }
    if (media.type === "webmap" && m.id) {
      const r = rid(), id = nid();
      res[r] = { type: "webmap", data: { type: "default", itemType: "Web Map", itemId: m.id } };
      nodes[id] = { type: "webmap", data: { map: r, caption: "", alt: "" }, config: { size: "wide" } };
      return id;
    }
    let url = m.url || "";
    if (!url && m.frameTag) { const x = /src=["']([^"']+)["']/i.exec(m.frameTag); if (x) url = x[1].replace(/&amp;/g, "&"); }
    if (media.type === "video" || media.type === "webpage") {
      if (!url) return null;
      return isVideoUrl(url) ? video(url) : link(url);
    }
    warnings.push(`${label}: סוג מדיה לא נתמך (${media.type})`);
    return null;
  }

  function addBlockNodes(props, blocks, actions, warnings, label, out) {
    const nodes = props.nodes, res = props.resources;
    const used = new Set();
    for (const b of blocks) {
      if (b.type === "p" || b.type === "ul" || b.type === "ol" || b.type === "h") {
        const id = nid();
        const type = b.type === "p" ? "paragraph" : b.type === "ul" ? "bullet-list" : b.type === "ol" ? "numbered-list" : "h3";
        nodes[id] = { type: "text", data: { text: b.html, type } };
        out.push(id);
        for (const a of b.acts || []) {
          if (used.has(a) || !actions[a]) continue;
          used.add(a);
          const mid = journalMediaNode(props, actions[a], warnings, label);
          if (mid) out.push(mid);
        }
      } else if (b.type === "image") {
        const mid = journalMediaNode(props, { type: "image", image: { url: b.src, caption: b.caption, altText: b.alt } }, warnings, label);
        if (mid) out.push(mid);
      } else if (b.type === "embed") {
        const mid = journalMediaNode(props, { type: "webpage", webpage: { url: b.url } }, warnings, label);
        if (mid) out.push(mid);
      }
    }
    return used;
  }

  // opts: { byline, themeItemId, coverImage: {url,width,height}|null }
  function buildJournalStory(j, opts) {
    opts = opts || {};
    const he = isHebrew(j.title);
    const props = newStoryTemplate(opts.byline, he ? "he" : "en-US", opts.themeItemId);
    setCover(props, j.title, "", opts.coverImage || null);
    props.nodes[props.root].config.coverDate = "none";
    const children = props.nodes[props.root].children;
    let at = children.findIndex((c) => (props.nodes[c] || {}).type === "credits");
    if (at < 0) at = children.length;
    const out = [];
    const warnings = j.warnings.slice();
    j.sections.forEach((s, i) => {
      const label = `מקטע ${i + 1} (${s.title})`;
      if (s.title) { const id = nid(); props.nodes[id] = { type: "text", data: { text: s.title, type: "h2" } }; out.push(id); }
      const mid = journalMediaNode(props, s.media, warnings, label);
      if (mid) out.push(mid);
      const used = addBlockNodes(props, htmlToBlocks(s.html), s.actions, warnings, label, out);
      // actions that are not linked from the text are shown at the end of the section (deduplicated)
      const seen = new Set();
      for (const [aid, am] of Object.entries(s.actions)) {
        if (used.has(aid)) continue;
        const key = JSON.stringify(am.webmap ? { t: "w", id: am.webmap.id } : am);
        if (seen.has(key)) continue; seen.add(key);
        const n = journalMediaNode(props, am, warnings, label);
        if (n) out.push(n);
      }
    });
    children.splice(at, 0, ...out);
    return { props, count: j.sections.length, warnings };
  }

  async function migrateMapJournal(session, j, log, opts) {
    opts = opts || {};
    let coverImage = null;
    const first = j.sections.find((s) => s.media && s.media.type === "image" && (s.media.image || {}).url);
    if (first) {
      coverImage = { url: httpsUrl(first.media.image.url) };
      const sz = await imageSize(coverImage.url); if (sz) Object.assign(coverImage, sz);
    }
    log("בונה סיפור...");
    const { props, count, warnings } = buildJournalStory(j, { byline: opts.byline || session.username, themeItemId: opts.themeItemId, coverImage });
    const id = await createStoryDraft(session, j.title, ["StoryMaps migration"].concat(j.tags), props);
    return { storyId: id, count, warnings, editUrl: `https://storymaps.arcgis.com/stories/${id}/edit` };
  }

  const api = { extractMapJournal, buildJournalStory, migrateMapJournal, htmlToBlocks, setFetch, getJSON, itemInfo, itemData, classify, listSource, extractMapTour, buildTourStory, migrateMapTour, captionToParagraphs, GRAY_IMAGERY_BASEMAP, _internal: { mercToLonLat, lonLatToMerc, cleanMedia } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Migrator = api;
})(typeof window !== "undefined" ? window : globalThis);

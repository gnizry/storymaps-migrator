# -*- coding: utf-8 -*-
"""
Migrate a classic Esri "Map Tour" story map to a new ArcGIS StoryMaps story
with a Guided Map Tour block.

What it does
  1. Reads the classic Map Tour app (item data) and its web map (public REST).
  2. Extracts the tour points in the original order: name, caption, image, location.
  3. Creates a new Web Map holding only the original basemap and reference layers.
  4. Creates a new StoryMap *draft* (not published) with a cover and a guided map tour.

Nothing is deleted or changed in the classic items. The new story stays a draft
until you open it in the StoryMaps builder and publish it yourself.

Usage
  Dry run (no login, nothing created, writes <appid>_places.json for review):
      python migrate_maptour.py e7a03b864ad34fd78cb242b882492ea9 --dry-run

  Create the draft story (asks for your password interactively):
      python migrate_maptour.py e7a03b864ad34fd78cb242b882492ea9 --user YOUR_USERNAME

  Inside an ArcGIS Online Notebook (already signed in):
      python migrate_maptour.py e7a03b864ad34fd78cb242b882492ea9 --home

Requires: pip install arcgis   (tested against arcgis 2.4.x)
"""
import argparse
import getpass
import html
import json
import math
import re
import sys
import uuid

import requests

PORTAL = "https://ramathanadiv.maps.arcgis.com"
REST = "https://www.arcgis.com/sharing/rest/content/items"

# Field-name candidates used by different versions of classic Map Tour
FIELD_ALIASES = {
    "name": ["name", "title", "nombre"],
    "caption": ["caption", "description", "desc", "descripcion"],
    "pic": ["url", "pic_url", "picture", "image", "media"],
    "thumb": ["thumb_url", "thumb", "thumbnail"],
    "lon": ["long", "lon", "longitude", "x"],
    "lat": ["lat", "latitude", "y"],
}


# --------------------------------------------------------------------------- fetching
def get_json(url, params=None):
    p = {"f": "json"}
    p.update(params or {})
    r = requests.get(url, params=p, timeout=60)
    r.raise_for_status()
    j = r.json()
    if isinstance(j, dict) and "error" in j:
        raise RuntimeError(f"{url}: {j['error']}")
    return j


def item_info(item_id):
    return get_json(f"{REST}/{item_id}")


def item_data(item_id):
    return get_json(f"{REST}/{item_id}/data")


# --------------------------------------------------------------------------- helpers
def pick(attrs, key):
    lower = {k.lower(): k for k in attrs}
    for cand in FIELD_ALIASES[key]:
        if cand in lower:
            return attrs[lower[cand]]
    return None


def merc_to_lonlat(x, y):
    lon = x / 6378137.0 * 180.0 / math.pi
    lat = (2 * math.atan(math.exp(y / 6378137.0)) - math.pi / 2) * 180.0 / math.pi
    return lon, lat


def lonlat_to_merc(lon, lat):
    x = lon * math.pi / 180.0 * 6378137.0
    y = math.log(math.tan(math.pi / 4 + lat * math.pi / 360.0)) * 6378137.0
    return x, y


def clean_media_url(u):
    if not u:
        return None
    u = u.strip()
    kind = "video" if "#isVideo" in u else "image"
    u = re.sub(r"#is(Image|Video)$", "", u)
    if u.startswith("http://"):
        u = "https://" + u[len("http://"):]
    return u, kind


def caption_to_paragraphs(caption):
    """Classic captions are HTML. StoryMaps text nodes accept light inline HTML
    (<strong>, <em>, <a>); block tags become separate paragraphs."""
    if not caption:
        return []
    c = caption.replace("\r", "")
    c = re.sub(r"(?i)<br\s*/?>", "\n", c)
    c = re.sub(r"(?i)</(p|div|li|h\d)>", "\n", c)
    c = re.sub(r"(?i)<(p|div|li|h\d|ul|ol|span|font)[^>]*>", "", c)
    c = re.sub(r"(?i)</(ul|ol|span|font)>", "", c)
    c = re.sub(r"(?i)<b>", "<strong>", c)
    c = re.sub(r"(?i)</b>", "</strong>", c)
    c = re.sub(r"(?i)<i>", "<em>", c)
    c = re.sub(r"(?i)</i>", "</em>", c)
    c = c.replace("&nbsp;", " ")
    paras = [re.sub(r"[ \t]+", " ", p).strip() for p in c.split("\n")]
    return [p for p in paras if p]


def is_hebrew(s):
    return bool(re.search(r"[֐-׿]", s or ""))


# --------------------------------------------------------------------------- extraction
def extract_tour(app_id):
    info = item_info(app_id)
    data = item_data(app_id)
    values = data.get("values", {})
    webmap_id = values.get("webmap")
    if not webmap_id:
        raise RuntimeError("This item has no web map - is it a Map Tour?")
    wm = item_data(webmap_id)

    src = values.get("sourceLayer") or ""
    layers = wm.get("operationalLayers", [])

    def matches(l):
        lid = l.get("id", "")
        return bool(src) and (src == lid or src.startswith(lid) or lid.startswith(src))

    tour_layer = next((l for l in layers if matches(l)), None)
    if tour_layer is None:
        tour_layer = next((l for l in layers if l.get("featureCollection")), None)
    if tour_layer is None:
        raise RuntimeError("Could not find the tour point layer in the web map")

    features = []
    if tour_layer.get("featureCollection"):
        for fl in tour_layer["featureCollection"].get("layers", []):
            features += fl.get("featureSet", {}).get("features", [])
    elif tour_layer.get("url"):
        q = get_json(
            tour_layer["url"].rstrip("/") + "/query",
            {"where": "1=1", "outFields": "*", "returnGeometry": "true", "outSR": "4326"},
        )
        features = q.get("features", [])
        for f in features:  # mark geometry as lon/lat
            f.setdefault("geometry", {})["_wgs84"] = True
    else:
        raise RuntimeError("Unsupported tour layer type")

    def oid(f):
        a = f["attributes"]
        for k in ("__OBJECTID", "OBJECTID", "ObjectId", "FID", "objectid"):
            if k in a:
                return a[k]
        return None

    by_id = {oid(f): f for f in features}
    order = values.get("order")
    if order:
        ordered = [by_id[o["id"]] for o in order if o.get("visible", True) and o["id"] in by_id]
    else:
        ordered = features

    places, warnings = [], []
    for f in ordered:
        a, g = f["attributes"], f.get("geometry") or {}
        lon, lat = pick(a, "lon"), pick(a, "lat")
        try:
            lon, lat = float(lon), float(lat)
        except (TypeError, ValueError):
            lon = lat = None
        if lon is None or not (-180 <= lon <= 180) or not (-90 <= lat <= 90):
            lon = lat = None
            if "x" in g and "y" in g:
                gx, gy = float(g["x"]), float(g["y"])
                wkid = (g.get("spatialReference") or {}).get("wkid")
                if g.get("_wgs84") or wkid == 4326 or (abs(gx) <= 180 and abs(gy) <= 90):
                    lon, lat = gx, gy
                else:
                    lon, lat = merc_to_lonlat(gx, gy)
        name = html.unescape(re.sub(r"<[^>]+>", "", str(pick(a, "name") or ""))).strip()
        media = clean_media_url(pick(a, "pic"))
        if media and media[1] == "video":
            warnings.append(f"'{name}': video media - added as a link, embed it by hand")
        places.append(
            {
                "name": name,
                "paragraphs": caption_to_paragraphs(pick(a, "caption")),
                "media": media[0] if media else None,
                "media_kind": media[1] if media else None,
                "lon": lon,
                "lat": lat,
            }
        )

    reference_layers = [
        {k: v for k, v in l.items()}
        for l in layers
        if l is not tour_layer and l.get("url") and not l.get("featureCollection")
    ]
    return {
        "app_id": app_id,
        "title": values.get("title") or info.get("title"),
        "subtitle": values.get("subtitle") or info.get("snippet") or "",
        "item_title": info.get("title"),
        "tags": info.get("tags", []),
        "first_record_as_intro": values.get("firstRecordAsIntro", False),
        "webmap_id": webmap_id,
        "basemap": wm.get("baseMap"),
        "spatialReference": wm.get("spatialReference", {"wkid": 102100}),
        "reference_layers": reference_layers,
        "places": places,
        "warnings": warnings,
    }


# --------------------------------------------------------------------------- story building
def nid():
    return "n-" + uuid.uuid4().hex[:6]


def rid():
    return "r-" + uuid.uuid4().hex[:6]


def add_tour_to_story(props, tour, basemap_webmap_id, intro_paragraphs=None):
    """Mutates a StoryMap JSON (story._properties) and inserts a guided map tour."""
    nodes, resources = props["nodes"], props.setdefault("resources", {})
    root = props["root"]

    basemap_res = rid()
    resources[basemap_res] = {
        "type": "webmap",
        "data": {"type": "minimal", "itemType": "Web Map", "itemId": basemap_webmap_id},
    }

    geometries, places = {}, []
    for p in tour["places"]:
        if p["lon"] is None:
            continue
        fid = str(uuid.uuid4())
        x, y = lonlat_to_merc(p["lon"], p["lat"])
        geometries[fid] = {
            "id": fid,
            "type": "POINT_NUMBERED_TOUR",
            "nodes": [{"long": p["lon"], "lat": p["lat"], "proX": x, "proY": y}],
        }

        title_id = nid()
        nodes[title_id] = {"type": "text", "data": {"text": p["name"], "type": "h3"}}

        content_ids = []
        paras = list(p["paragraphs"])
        if p["media_kind"] == "video" and p["media"]:
            paras.append(f'<a href="{p["media"]}" target="_blank">וידאו</a>')
        for para in paras:
            t = nid()
            nodes[t] = {"type": "text", "data": {"text": para, "type": "paragraph"}}
            content_ids.append(t)

        place = {"id": nid(), "featureId": fid, "contents": content_ids, "title": title_id}
        if p["media"] and p["media_kind"] == "image":
            img_res = rid()
            resources[img_res] = {"type": "image", "data": {"src": p["media"], "provider": "uri"}}
            img = nid()
            nodes[img] = {
                "type": "image",
                "data": {"image": img_res},
                "config": {"placement": {"type": "fit", "fit": {"color": "backgroundColor"}}},
            }
            car = nid()
            nodes[car] = {"type": "carousel", "children": [img]}
            place["media"] = car
        places.append(place)

    map_id = nid()
    nodes[map_id] = {
        "type": "tour-map",
        "data": {
            "geometries": geometries,
            "alt": "",
            "basemap": {"type": "resource", "value": basemap_res},
        },
    }
    tour_id = nid()
    nodes[tour_id] = {
        "type": "tour",
        "data": {
            "type": "guided-tour",
            "subtype": "media-focused",
            "narrativePanelPosition": "start",
            "narrativePanelSize": "small",
            "accentColor": "accentColor1",
            "map": map_id,
            "places": places,
        },
    }

    new_children = []
    for para in intro_paragraphs or []:
        t = nid()
        nodes[t] = {"type": "text", "data": {"text": para, "type": "paragraph"}}
        new_children.append(t)
    new_children.append(tour_id)

    children = nodes[root].setdefault("children", [])
    # insert after cover/navigation, before credits
    insert_at = len(children)
    for i, c in enumerate(children):
        if nodes.get(c, {}).get("type") == "credits":
            insert_at = i
            break
    children[insert_at:insert_at] = new_children
    return len(places)


def set_cover(props, title, summary):
    for n in props["nodes"].values():
        if n.get("type") == "storycover":
            n.setdefault("data", {})["title"] = title
            n["data"]["summary"] = summary
            return


def create_basemap_webmap(gis, tour):
    wm = {
        "operationalLayers": tour["reference_layers"],
        "baseMap": tour["basemap"],
        "spatialReference": tour["spatialReference"],
        "version": "2.31",
        "authoringApp": "migrate_maptour.py",
        "authoringAppVersion": "1",
    }
    props = {
        "type": "Web Map",
        "title": f"{tour['item_title']} - מפת בסיס לסיור (StoryMaps)",
        "tags": ["StoryMaps migration"] + list(tour["tags"]),
        "snippet": f"Basemap for the migrated tour of classic app {tour['app_id']}",
    }
    folder = gis.content.folders.get()
    res = folder.add(props, text=json.dumps(wm))
    item = res.result() if hasattr(res, "result") else res
    return item


def build(gis, tour, locale=None):
    from arcgis.apps.storymap import StoryMap

    wm_item = create_basemap_webmap(gis, tour)
    print(f"  basemap web map: {wm_item.id}")

    story = StoryMap(gis=gis)
    props = story._properties
    places = tour["places"]
    intro = None
    if tour["first_record_as_intro"] and places:
        intro = places[0]["paragraphs"]
        tour = dict(tour, places=places[1:])
    set_cover(props, tour["title"], tour["subtitle"])
    n = add_tour_to_story(props, tour, wm_item.id, intro)
    story.story_locale = locale or ("he-IL" if is_hebrew(tour["title"]) else "en-US")
    item = story.save(title=tour["title"], tags=["StoryMaps migration"] + list(tour["tags"]))
    return item, n


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("appid", help="classic Map Tour item id")
    ap.add_argument("--dry-run", action="store_true", help="extract only, create nothing")
    ap.add_argument("--user", help="ArcGIS Online username")
    ap.add_argument("--home", action="store_true", help="use GIS('home') inside an ArcGIS Notebook")
    ap.add_argument("--portal", default=PORTAL)
    ap.add_argument("--locale", help="story locale, e.g. he-IL or en-US (auto by title)")
    a = ap.parse_args()

    print(f"Reading classic Map Tour {a.appid} ...")
    tour = extract_tour(a.appid)
    out = f"{a.appid}_places.json"
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(tour, fh, ensure_ascii=False, indent=2)
    print(f"  '{tour['title']}': {len(tour['places'])} places  ->  {out}")
    for w in tour["warnings"]:
        print("  ! " + w)
    missing = [p["name"] for p in tour["places"] if p["lon"] is None]
    if missing:
        print("  ! no location for: " + ", ".join(missing))
    if a.dry_run:
        return

    from arcgis.gis import GIS

    if a.home:
        gis = GIS("home")
    else:
        if not a.user:
            sys.exit("Pass --user USERNAME (or --home inside an ArcGIS Notebook)")
        gis = GIS(a.portal, a.user, getpass.getpass(f"Password for {a.user}: "))
    print(f"Signed in as {gis.users.me.username}")

    item, n = build(gis, tour, a.locale)
    print(f"\nDone. Draft story with {n} places: {item.id}")
    print(f"Open in builder: https://storymaps.arcgis.com/stories/{item.id}/edit")


if __name__ == "__main__":
    main()

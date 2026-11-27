# StoryMaps migrator

A static web app that reads classic Esri story maps and recreates them as
ArcGIS StoryMaps drafts. It runs fully in the browser, with no server, so it
can be hosted on GitHub Pages.

## What works now
- Scan a gallery app, a group or a single item, and classify each classic template.
- Map Tour: preview the places, then create a new web map (basemap and reference
  layers only) plus a StoryMap draft with a Guided Map Tour.
- A JSON backup of any item's data.

Nothing existing is changed or deleted, and drafts are never published automatically.

## Setup
1. In ArcGIS Online: Content > New item > Developer credentials > OAuth 2.0 credentials.
   Add the GitHub Pages URL (e.g. `https://<user>.github.io/<repo>/`) as a redirect URL.
2. Put the Client ID into `config.js`.
3. Settings > Pages > Deploy from branch `main`, folder `/ (root)`.

Sign-in uses OAuth 2.0 with PKCE. The token stays in the tab's sessionStorage only.

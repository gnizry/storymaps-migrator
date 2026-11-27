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

Sign-in is with an ArcGIS username and password (built-in accounts; SSO or MFA accounts need OAuth with a Client ID). The password goes only to ArcGIS and is never stored; the token stays in sessionStorage.

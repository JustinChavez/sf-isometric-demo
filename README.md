# SF Isometric Demo

A small public demo of the SF-isometric experiment: controlled 3D city views of downtown
San Francisco translated into a tileable isometric visual language.

## What the page shows

- the 200 m downtown baseline, stitched into one 5632 × 4608 px mosaic (99 quadrants)
- honest progress numbers: 80 tiles generated, 1024 px source tiles
- landmark jumps for Coit Tower and Washington Square
- an interactive map: wheel/button zoom, drag to pan, click a quadrant to inspect it
- a short why-me section: the earlier SF Park Game launch, and ML/agent background

This is an in-progress research demo, not a finished full-city map. Only the baseline run
is published here. The original scale-up estimate is approximately 14,400 tiles: a 12 km ×
12 km area at the planned 100 m pitch. The next map goal is a Coenen-style San Francisco map.
The cost-reduction research path includes Krea 2 style transfer, a Turbo/Lightning LoRA, and
other edit-capable model and inference experiments. If generation cost drops far enough with
faster few-step inference, the larger ambition is the entire Bay Area, guided by
[this WorldView-3 satellite image](https://www.reddit.com/r/interestingasfuck/comments/1p6v65l/sf_bay_seen_from_400_mi_away_worldview3_satellite/).

## Run locally

No build step and no dependencies:

```bash
python3 -m http.server 4173   # then open http://localhost:4173
npm run check                 # node --check app.js
```

## Deploy

Static site: project root, no build command, no output directory. Import the repository in
the Vercel dashboard, or run `vercel` from this directory.

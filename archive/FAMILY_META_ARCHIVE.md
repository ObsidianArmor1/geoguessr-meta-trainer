# Clustering-family trainer archive

The complete clustering-based meta trainer was frozen before the public
userscript became similarity-only.

- Permanent Git tag: `family-meta-trainer-v1`
- Tagged commit: `9dcc708`
- GitHub snapshot: https://github.com/ObsidianArmor1/geoguessr-meta-trainer/tree/family-meta-trainer-v1
- Archived userscript: `src/geoguessr-meta-trainer.user.js` at that tag
- Archived family-capable API: `src/portable-api.js` at that tag

The family catalogs, detector membership, representative examples, click
recommendations, and review policy remain embedded in the tagged map cores:

- `data/maps/balanced-usa-50k/core.json.gz`
  - SHA-256: `99b8bf89a61177b576090c3d4a5ab996ae717492490a54e7f297adf1d18fab22`
- `data/maps/balanced-world-50k/core.json.gz`
  - SHA-256: `5f68279003cc0a972f9069f3496cc6bd1dd2b0e5b5378bf64d4f22efcc4db95b`

The active map cores intentionally remain family-capable as well. The active
userscript simply requests the similarity-only neighborhood route and never
fetches family details. This keeps the atlas/data artifacts intact and makes a
future optional family add-on possible without rebuilding the discoveries.

To restore or spin off the old implementation, branch from the tag:

```sh
git switch -c codex/family-meta-addon family-meta-trainer-v1
```

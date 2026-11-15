# Community directory review fix — 2026-11-15

Goal: find why Folder Focus does not pass the community.obsidian.md automated review and prepare 1.2.2.

- [x] Reproduce the review pipeline locally: `npm ci` (npm 10 and 11), `npm run build`, compare with 1.2.1 release assets → byte-identical; attestations exist for all three assets.
- [x] Lint with `eslint-plugin-obsidianmd` 0.6.0 and the scanner's ignore list (plus `no-unsanitized`) → no findings.
- [x] Policy gap found: the plugin reads files outside the vault (Finder/Explorer drag-in import via Node `fs`), but the README did not disclose it. Obsidian developer policies require this disclosure. Added a Disclosures section.
- [x] Update `eslint-plugin-obsidianmd` to ^0.6.0.
- [x] Bump to 1.2.2 (manifest, package, lock, versions, README, CHANGELOG). `main.js` is unchanged by the bump.
- [ ] After merge: tag `1.2.2`, let the release workflow publish, then run the review again on community.obsidian.md and check the dashboard.

Unverified: the dashboard's actual error text was not available. If the scan still fails, the dashboard message is needed to go further.

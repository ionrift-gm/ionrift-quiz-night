# Changelog

## [1.0.0] - 2026-09-28

General availability release. Run live pub quizzes inside Foundry VTT with player answer sheets, fog-of-war standings, and mystery prize delivery.

### Added
- Nearest-number round type for numeric trivia and tiebreakers.
- Live round overview matrix on the Quizmaster panel.
- Centralised socket transport through Ionrift Library.

### Changed
- Answers remain editable by players until question lock.
- Standings reveal from the bottom up during the final ceremony.

## [0.1.0-ea.2] - 2026-09-20

### Added
- Sound triggers for Ionrift Resonance.

### Changed
- Dropdown menus now display visible selection chevrons.
- Clarified round points to show points per question with tooltip guidance.
- Locked window sizes keep the editor and quizmaster panels stable across screens.

## [0.1.0-ea.1] - 2026-09-07

First early access. Build a quiz in Foundry, run it live, keep standings fogged until the end, and hand out gold and items.

### Added
- In-app editor for rounds and questions. Text, multiple choice, true/false, and picture rounds.
- Quizmaster panel and player answer apps over sockets.
- Fog of War standings. Teaser ranks between rounds. Bottom-up final reveal.
- Prize window for 1st, 2nd, and Everyone. Drop items from the sidebar or a compendium. A placing can hold more than one item. Mystery can hide gold or a single item.
- Everyone items mint a copy for each player below 2nd.
- JSON import and export.
- Chat announcements, token toolbar button, and `/quiz`.
- Module settings can open Quiz Night and can hide the token toolbar button.

### Changed
- Text answers forgive up to 5 character differences. That is not a setting.

Audio rounds, wager rounds, and the Halloween skin are not in this build.

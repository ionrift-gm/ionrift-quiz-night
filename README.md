# Ionrift Quiz Night

![Downloads](https://img.shields.io/github/downloads/ionrift-gm/ionrift-quiz-night/total?color=violet&label=Downloads)
![Version](https://img.shields.io/github/v/release/ionrift-gm/ionrift-quiz-night?color=violet&label=Latest%20Version)
![Foundry Version](https://img.shields.io/badge/Foundry-v12-333333?style=flat&logo=foundryvirtualtabletop)
![Systems](https://img.shields.io/badge/system-system--agnostic-blue)

**Live campaign quizzes, trivia recaps, and pub games inside Foundry VTT.**

Write questions about your campaign, run live trivia for your players, and hand out mystery prizes at the table.

### Support Ionrift

[![Patreon](https://img.shields.io/badge/Patreon-ionrift-ff424d?logo=patreon&logoColor=white)](https://patreon.com/ionrift)
[![Discord](https://img.shields.io/badge/Discord-Ionrift-5865F2?logo=discord&logoColor=white)](https://discord.gg/vFGXf7Fncj)

> Documentation, setup guides, and troubleshooting: **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)**

Write questions about the campaign, run them at the table, and keep standings fogged until the end. Players answer on their own screens. The GM marks and hands out gold or items.

## How it works

1. **Write.** Open Quiz Night from `/quiz` or the token toolbar. Add rounds and questions in the editor.
2. **Stake.** Drop items onto 1st, 2nd, or Everyone in the prizes window. Mystery can hide gold or a single item.
3. **Run.** Start the quiz. Players get an answer app. The GM advances questions and marks.
4. **Reveal.** Between rounds, standings stay partial. The ceremony lists everyone from the bottom up.

## Features

- Text, multiple choice, true/false, picture, and nearest-number rounds.
- Answers update on the GM panel as they come in. Players can change an answer until the question is locked.
- Fogged standings. Teaser ranks between rounds, full table at the end.
- Prize window with drag-and-drop items. Everyone below 2nd gets a copy of each Everyone item.
- JSON import and export.
- Works with any game system. Gold delivery uses the active system's currency when it can.

## Installation

Install directly within Foundry VTT:
1. Open **Add-on Modules** and click **Install Module**.
2. Search for **Ionrift Quiz Night** and click **Install**.

Alternatively, install using the Manifest URL:
`https://github.com/ionrift-gm/ionrift-quiz-night/releases/latest/download/module.json`

Enable **Ionrift Quiz Night** and **Ionrift Library**. Reload the world.

Forge hosts: import the module directly or install from the Forge Bazaar when listed.

Walkthrough: **[Setup: Quiz Night](https://github.com/ionrift-gm/ionrift-library/wiki/16-Setup-Quiz-Night)**

## Usage

- `/quiz` or `/quiznight` in chat
- Token toolbar button (can be hidden in settings)
- **Game Settings > Module Settings > Ionrift Quiz Night > Open**

## Dependencies

| Module | Required? | What it enables |
|--------|-----------|-----------------|
| [`ionrift-library`](https://github.com/ionrift-gm/ionrift-library) v3.0.0+ | **Yes** | Shared UI and logging |

## Settings

| Setting | What it does | Default |
|---------|-------------|---------|
| Token toolbar button | Show the Quiz Night control on the token toolbar | On |
| Debug Mode | Verbose client logging | Off |

## Documentation

Full guides on the **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)**:

- **[Setup: Quiz Night](https://github.com/ionrift-gm/ionrift-library/wiki/16-Setup-Quiz-Night)**: install, editor, prizes, settings
- **[Running a quiz](https://github.com/ionrift-gm/ionrift-library/wiki/17-Quiz-Night-Running)**: live flow, marking, ceremony

Feel free to share quiz JSON in **#community-packs** on the [Ionrift Discord](https://discord.gg/vFGXf7Fncj).

## Bug Reports

1. Check the **[Ionrift Wiki](https://github.com/ionrift-gm/ionrift-library/wiki)** for common fixes.
2. Post to the **[Ionrift Discord](https://discord.gg/vFGXf7Fncj)** with Foundry version, module versions, and any console errors (F12).
3. Open a **[GitHub Issue](https://github.com/ionrift-gm/ionrift-quiz-night/issues)**.

## License

MIT License. See [LICENSE](./LICENSE) for details.

---

## Ionrift Module Suite

- **[Respite](https://github.com/ionrift-gm/ionrift-respite)**: Structured rest phases and downtime activities
- **[Monstrous Feast](https://github.com/ionrift-gm/ionrift-monstrous-feast)**: Butcher slain creatures and cook camp meals with buffs
- **[Resonance](https://github.com/ionrift-gm/ionrift-resonance)**: Context-sensitive combat soundscapes and audio cues
- **[Quartermaster](https://github.com/ionrift-gm/ionrift-quartermaster)**: Loot cache generation and inventory management
- **[Waterline](https://github.com/ionrift-gm/ionrift-waterline)**: Traced water caustics and procedural border walls
- **[Ionrift Library](https://github.com/ionrift-gm/ionrift-library)**: Shared ecosystem kernel and creature index

[Wiki](https://github.com/ionrift-gm/ionrift-library/wiki) · [Website](https://ionrift.cloud/modules/quiz-night/) · [Discord](https://discord.gg/vFGXf7Fncj) · [Patreon](https://patreon.com/ionrift)

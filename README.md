# Narrative Engine

Your AI Dungeon Master. A self-hosted TTRPG engine that runs extended, multi-session campaigns with persistent memory, living NPCs, and automated world management — powered by any OpenAI-compatible LLM or local Ollama model.

No cloud. No subscription. Your campaigns stay on your machine.

---

## Getting Started

1. **Clone the repo**
   ```
   git clone https://github.com/Sagesheep/NarrativeEngine.git
   cd NarrativeEngine
   ```

2. **Install & Run**

   **Windows** — just double-click `Start_Narrative_Engine.bat`

   **Or manually:**
   ```
   npm install
   npm run dev
   ```

3. **Open your browser** to `http://localhost:5173`

4. **Configure your LLM** — Open Settings and add your API key + endpoint. Supports OpenAI, Ollama, and any OpenAI-compatible API.

That's it. Create a campaign, write your world lore, and start playing.

---

## Setting Up Your First Campaign

The `Example_Setup/` folder contains a complete ready-to-play campaign: **The Awakening** — a gritty survival fantasy where humanity huddles behind massive walls 100 years after a meteor mutated all non-humanoid life into monsters. It's a great way to see how the engine works.

### What's in the example

| File | What it does |
|---|---|
| `Spirit_Card_World_Lore.md` | The world bible — continents, factions, locations, characters, rules. Paste this into the **Lore** section when creating your campaign. |
| `Rulebook v3.2.md` | The GM's instruction set — output formatting, NPC behavior, dice resolution, event handling. Paste this into the **System Prompt** field in campaign settings. |
| `starter_prompt.md` | The opening scene + walkthrough — tells the GM to guide character creation step-by-step before starting the story. Send this as your **first message** to the GM. |

### How to use it

1. Create a new campaign
2. Open the **World Info (Lore)** tab and paste the contents of `Spirit_Card_World_Lore.md`
3. Open **Campaign Settings** and paste the contents of `Rulebook v3.2.md` into the System Prompt field
4. Start a new chat and paste the contents of `starter_prompt.md` as your first message
5. The GM will walk you through character creation and then drop you into the world

### Writing your own setup

You can use the example as a template for any setting:

- **Lore** — Write your world in Markdown using `##` and `###` headers. Each section becomes a lore chunk the GM can recall. Use `[CHUNK: TYPE -- NAME]` prefixes to classify entries. Supported types: `world_overview`, `faction`, `location`, `character`, `power_system`, `economy`, `event`, `relationship`, `rules`, `culture`, `misc`
- **System Prompt** — Define how the GM behaves: tone, output format, NPC behavior rules, dice resolution, event protocols. The engine handles memory and recall — you just define the style and rules
- **First Message** — Set the scene or give the GM a starting instruction. You can describe an opening scenario, ask for character creation, or just say "begin"

---

## Features

### Your Campaign, Your World

- Run multiple campaigns side by side, each with its own world, lore, and state
- Write a rich world bible (lore) using plain Markdown — locations, factions, power systems, cultures, rules
- Lore entries are auto-classified and triggered by keywords in the conversation
- Pin critical lore (rules, economy, magic systems) so it's always in the GM's context

### World Lore Builder

A structured pre-game world editor separate from your in-campaign lore:

- Fill out dedicated fields for world background, languages, power systems, technology level, timeline, tone, and house rules
- Manage expandable lists for geography, factions, cultures, threats, and pre-seeded NPCs
- Export your world to Markdown with one click for backup or sharing
- Import Markdown back with a smart review modal that merges changes without overwriting your work
- Supports multiple draft worlds — switch between them or delete old ones

### Smart Memory That Actually Works

The GM remembers your past sessions without you doing anything:

- **Session summaries** — old chat history is automatically condensed into running summaries while keeping memorable quotes intact
- **Scene archive** — every scene is saved verbatim in a lossless log, never thrown away
- **Chapters** — the story is auto-organized into chapters as you play, with LLM-generated summaries
- **Semantic search** — when the GM needs to recall something, it searches your entire history by meaning, not just keywords

#### Auto-Condense with Context Strategy

When approaching the token limit, old turns are compressed automatically:

- Three strategies: **tight** (aggressive 50% compression), **smart** (balanced 75%), **deep** (conservative, maximum detail)
- The most recent 8 messages are always kept verbatim — only older history is condensed
- Dice rolls, HP/MP values, and all proper names are always preserved exactly
- Memorable and dramatic moments are tagged and survive re-compression
- When even the compressed summary grows large, older sections are re-compressed automatically

#### Deep Archive Search

When the engine needs to recall something from a sealed chapter, it runs a two-phase LLM search:

- Phase 1 scans chapter overviews to find all relevant sealed chapters
- Phase 2 selects specific scenes within those chapters
- Results are ranked by importance score and injected verbatim into context
- Activated automatically when token pressure is high

### Living NPCs

- NPCs are **automatically detected** as they appear in the story — no manual data entry
- The AI generates full profiles: personality, voice, goals, factions, visual descriptions
- **Portrait generation** with 5 art styles: Realistic, Anime Realistic, Anime, Western RPG, Chibi
- **NPC archiving** — inactive NPCs are automatically archived to reduce context clutter and restored when they reappear
- Personality drift is tracked — if an NPC's attitude shifts, you'll see a drift alert for 3 turns

#### NPC Drives & Pressure

Each NPC has a psychological layer that creates emergent behavior:

- **Drives**: a core long-term want, a session-level want, and an immediate scene want
- **Pressure counters**: `ignored` and `engaged` track how the player is treating each NPC, with natural decay over time
- **Behavioral triggers**: keyword mappings that cause pressure spikes when crossed
- **Boundaries**: hard limits (NPC refuses) and soft limits (NPC resists but complies, pressure rises)
- Pressure history is logged per NPC so you can see how the relationship evolved

#### Witness-Based Recall

The GM tracks who was in the room:

- Every scene records which NPCs were physically present (witnesses) vs. merely mentioned
- Witness presence is detected from scene headers first, with an Auxiliary AI fallback for edge cases
- When recalling past events, witness-matching scenes are ranked higher — so a character only "remembers" things they actually saw
- Prevents NPCs from referencing secrets, deals, or events they weren't present for

### World State Tracking (Divergence Register)

A living fact-sheet the GM maintains throughout your campaign:

- Automatically extracts world-state facts after each turn: who's where, who holds what, who killed who, who's allied with who
- Organized into categories: locations, NPC events, promises & debts, world state, party facts, lore & rules, misc
- Pin high-priority facts so they're always injected into context regardless of token budget
- Enable or disable individual facts, or toggle entire categories or chapters
- Review auto-extracted facts and edit or discard them via the Divergence Review modal
- AI-assisted structuring for manual entries — paste raw notes and let the engine categorize them
- A pruned log keeps a record of removed entries for reference

### Lore Check

A consistency QA tool you can run on any message:

- Select text from any chat message to flag it for review
- Choose from check categories: wrong fact, contradicts lore, wrong NPC/place, tone mismatch, out of character
- The engine cross-references your lore chunks, chapter archive index, and sealed chapters
- Returns a verdict (consistent / unsupported / contradicts), specific issues with citations, and a suggested rewrite
- Accept the rewrite with one click to replace the message text in place

### Overworld Map

A procedurally generated world map tied to your campaign:

- Generates terrain using Perlin noise with Voronoi biome clustering: plains, hills, mountains, coast, swamp, forest, deep ocean, and more
- Supports multiple world shapes: single continent, two continents, archipelago, coastal kingdom
- Named landmarks snap to cardinal anchor positions and display on the interactive canvas
- Player position is tracked on the overworld grid as you move through the story
- Add custom map pins for locations, events, or points of interest

### Dice & Randomness

Three engines that create emergent storytelling:

- **Surprise Engine** — ambient flavor events (a mysterious sound, a fleeting shadow). Default threshold DC 95, drops by 3 per turn.
- **Encounter Engine** — mid-stakes hooks and challenges. Default threshold DC 198, drops by 2 per turn.
- **World Event Engine** — seismic shifts (a coup, a natural disaster, a god intervenes). Default threshold DC 498, drops by 2 per turn. Generates a four-part event: who, what, why, where.

Each engine's threshold decreases over time, so the longer nothing happens, the more likely something will. All thresholds, decay rates, and event tables are fully configurable.

The **Dice Fairness** system pre-rolls d20 pools each turn and injects them as structured outcomes for 7 skill categories (Combat, Perception, Stealth, Social, Movement, Knowledge, Mundane) with Disadvantage / Normal / Advantage tiers — ensuring the GM uses fair rolls rather than hand-waving outcomes.

### Image Generation

- Generate NPC portraits on the fly in 5 art styles
- Generate scene illustrations during play
- Works with any OpenAI-compatible image API
- Images are downloaded and stored locally

### Your Data, Your Control

- **Encrypted API key vault** — AES-256-GCM encryption, password-optional
- **Machine-key mode** — no password needed, keys auto-unlock on your device
- **Password mode** — PBKDF2 with 100K iterations for full lock-down
- **Client-side encryption** — API keys are encrypted in your browser before they ever touch the server
- All campaign data is stored locally as files — no database, no cloud, no vendor lock-in
- Export and import your vault for backups

### Backups & Rollback

- **Automatic backups** created before any risky operation
- **Manual labeled backups** anytime
- **Batch backup deletion** for cleanup
- **Scene-level rollback** — undo any scene and the entire world state (timeline, chapters, NPCs) cascades back to that point
- Invalidated chapters auto-unseal, timeline entries are pruned, condenser resets if needed
- Pre-rollback safety backup so you can't lose data even when rolling back

### LLM Tool Calls

The GM can use tools mid-conversation:

- **Query Campaign Lore** — the GM looks up your world bible on the fly when it needs a detail
- **Update Scene Notebook** — a volatile working memory for tracking active spells, timers, NPC positions, environmental conditions

Works with OpenAI function calling and DeepSeek models (with DSML fallback parsing).

---

## Supported LLM Providers

Any OpenAI-compatible API works. Configure up to 5 endpoints per preset:

| Role | Purpose |
|---|---|
| **Story AI** | Main GM narration — required |
| **Summarizer AI** | Condensing old history (can use a cheaper/faster model) |
| **Utility AI** | Lore checks, divergence structuring, archive reranking, query expansion |
| **Image AI** | Portrait and scene generation |
| **Auxiliary AI** | Witness capture (NPC presence detection) and scene analysis fallback |

Each endpoint has its own model, API key, base URL, and sampling config (temperature, top-p, max tokens). Thinking/reasoning effort is supported where the provider offers it.

Works great with Ollama for fully local play — no internet required after setup.

---

## Quick Reference

| Action | Command |
|---|---|
| Install & run (Windows) | Double-click `Start_Narrative_Engine.bat` |
| Install manually | `npm install` |
| Start the app | `npm run dev` |
| Run tests | `npm run test` |
| Lint | `npm run lint` |

---

## License

This project is licensed under the [MIT License](LICENSE) — Copyright (c) 2026 Sagesheep.

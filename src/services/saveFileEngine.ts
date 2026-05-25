import type { ChatMessage, GameContext, ProviderConfig, EndpointConfig, ArchiveChapter, DivergenceEntry, NPCEntry } from '../types';
import { countTokens } from './tokenizer';
import { extractJson } from './payloadBuilder';
import { callLLM } from './callLLM';
import { DIVERGENCE_CATEGORIES, CATEGORY_DEFINITIONS, coerceCategory } from './divergenceRegister';
import { uid } from '../utils/uid';

const BATCH_TOKEN_LIMIT = 100_000; // max tokens per LLM call for save engine

function chunkMessagesByTokenBudget(messages: ChatMessage[], budget: number): ChatMessage[][] {
    const chunks: ChatMessage[][] = [];
    let currentChunk: ChatMessage[] = [];
    let currentTokens = 0;

    for (const msg of messages) {
        const cost = countTokens(msg.content);
        if (currentTokens + cost > budget && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }
        currentChunk.push(msg);
        currentTokens += cost;
    }
    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
}

// ─── Header Index Section Headers (from header_index.md template) ───
const HEADER_INDEX_SECTIONS = [
    'SECTION 1 — ARC / SESSION HEADER DATABASE',
    'SECTION 2 — PENDING LOOPS',
];

const HEADER_INDEX_REQUIRED_FIELDS = [
    'SESSION_ID:',
    'SCENE_HEADERS:',
];

// ─── Validators ───

const DASH_VARIANTS = /[\u2014\u2013\u2012\u2010\u00AF\u02D7\u2011\u2043\u2212\u30FC\u2015]/g;
const REPLACEMENT_CHAR = /\uFFFD/g;

function normalizeForComparison(text: string): string {
    return text.normalize('NFC').replace(DASH_VARIANTS, '—').replace(REPLACEMENT_CHAR, '—');
}

function containsNormalized(haystack: string, needle: string): boolean {
    return normalizeForComparison(haystack).includes(normalizeForComparison(needle));
}



export function validateHeaderIndex(output: string): { valid: boolean; missing: string[] } {
    const missing = [
        ...HEADER_INDEX_SECTIONS.filter((s) => !containsNormalized(output, s)),
        ...HEADER_INDEX_REQUIRED_FIELDS.filter((f) => !containsNormalized(output, f)),
    ];
    return { valid: missing.length === 0, missing };
}

// ─── Header Index Generator ───

function buildHeaderIndexPrompt(recentMessages: ChatMessage[], existingHeaderIndex: string): string {
    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    return [
        'You are a TTRPG session indexer. Generate NEW scene header entries for the Header Index.',
        '',
        'OUTPUT FORMAT — You MUST include BOTH sections with these EXACT headers:',
        '',
        '=====================================================================',
        'SECTION 1 — ARC / SESSION HEADER DATABASE',
        '=====================================================================',
        'SESSION_ID: [ARC_SESSION_ID]',
        'SESSION_TITLE: [title]',
        '',
        'SCENE_HEADERS:',
        '  - SCENE_ID: [unique scene ID]',
        '    HEADER: [TAG:TAG] factual header',
        '    THREADS: [THREAD_A], [THREAD_B]',
        '    DELTA: { Key: +Change }',
        '',
        '=====================================================================',
        'SECTION 2 — PENDING LOOPS (UNRESOLVED THREADS)',
        '=====================================================================',
        'LOOP_ID: [THREAD_TAG] Description. (Pressure: Low|Medium|High)',
        '',
        'RULES:',
        '1. For Section 1: output ONLY NEW scene headers from the recent turns',
        '2. For Section 2: output the COMPLETE current list of unresolved threads',
        '3. Use SCENE_ID format that follows existing patterns',
        '4. NO prose — factual index entries only',
        '5. Each SCENE_HEADERS entry must have SCENE_ID, HEADER, THREADS, and DELTA',
        '',
        'EXISTING HEADER INDEX (for reference — do NOT repeat existing SCENE_IDs):',
        existingHeaderIndex || '[No prior index — generate fresh from turns]',
        '',
        'RECENT SESSION TURNS:',
        turns,
    ].join('\n');
}

function splitHeaderIndexSections(text: string): { section1: string; section2: string } {
    const normalized = normalizeForComparison(text);
    const s2Regex = /SECTION 2[—–\u2013\u2014\u2015]PENDING LOOPS/;
    const match = s2Regex.exec(normalized);

    if (!match) {
        return { section1: text, section2: '' };
    }

    const s2Pos = match.index;
    const beforeS2 = text.substring(0, s2Pos);
    const lastSep = beforeS2.lastIndexOf('=====');
    const splitPoint = lastSep !== -1 ? lastSep : s2Pos;

    return {
        section1: text.substring(0, splitPoint).trim(),
        section2: text.substring(splitPoint).trim(),
    };
}

function extractSceneIds(text: string): Set<string> {
    const ids = new Set<string>();
    const regex = /SCENE_ID:\s*(\S+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        ids.add(match[1]);
    }
    return ids;
}

export function mergeHeaderIndex(existing: string, llmOutput: string): string {
    const existingSections = splitHeaderIndexSections(existing);
    const newSections = splitHeaderIndexSections(llmOutput);

    // Section 1: Append new scene headers (deduplicate by SCENE_ID)
    const existingIds = extractSceneIds(existingSections.section1);
    const newS1Lines = newSections.section1.split('\n');

    // Extract only new scene blocks that don't have duplicate SCENE_IDs
    const newSceneBlocks: string[] = [];
    let currentBlock: string[] = [];
    let currentId = '';
    let inBlock = false;

    for (const line of newS1Lines) {
        const idMatch = line.match(/SCENE_ID:\s*(\S+)/);
        if (idMatch) {
            // Save previous block if it has a new ID
            if (inBlock && currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
                newSceneBlocks.push(currentBlock.join('\n'));
            }
            currentBlock = [line];
            currentId = idMatch[1];
            inBlock = true;
        } else if (inBlock) {
            currentBlock.push(line);
        }
    }
    // Don't forget the last block
    if (inBlock && currentBlock.length > 0 && currentId && !existingIds.has(currentId)) {
        newSceneBlocks.push(currentBlock.join('\n'));
    }

    // Build merged Section 1: existing + new entries appended
    let mergedSection1 = existingSections.section1;
    if (!mergedSection1.trim()) {
        mergedSection1 = newSections.section1;
    } else if (newSceneBlocks.length > 0) {
        mergedSection1 = mergedSection1.trimEnd() + '\n\n' + newSceneBlocks.join('\n\n');
    }

    // Section 2: Full overwrite with new pending loops
    const mergedSection2 = newSections.section2 || existingSections.section2;

    return mergedSection1 + '\n\n' + mergedSection2;
}

export async function generateHeaderIndex(
    provider: ProviderConfig | EndpointConfig,
    recentMessages: ChatMessage[],
    existingHeaderIndex: string,
    maxRetries = 1
): Promise<{ headerIndex: string; success: boolean }> {
    const chunks = chunkMessagesByTokenBudget(recentMessages, BATCH_TOKEN_LIMIT);

    let runningIndex = existingHeaderIndex;
    let anySuccess = false;

    for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        let batchSuccess = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const prompt = attempt === 0
                ? buildHeaderIndexPrompt(chunk, runningIndex)
                : buildHeaderIndexPrompt(chunk, runningIndex) +
                  '\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Ensure BOTH sections are present with SCENE_HEADERS entries.';

            console.log(`[SaveFileEngine] Generating Header Index... (Batch ${ci + 1}/${chunks.length}, Attempt ${attempt + 1})`, {
                messages: chunk.length,
                promptTokens: countTokens(prompt)
            });

            const output = await callLLM(provider, prompt, { priority: 'low' });
            const { valid } = validateHeaderIndex(output);

            if (valid) {
                const merged = mergeHeaderIndex(runningIndex, output);
                const mergedValid = validateHeaderIndex(merged);
                if (mergedValid.valid) {
                    runningIndex = merged;
                    batchSuccess = true;
                    anySuccess = true;
                    break;
                }
                console.warn(`[SaveFileEngine] Header Index batch ${ci + 1} merged result failed validation:`, mergedValid.missing);
            }
            console.warn(`[SaveFileEngine] Header Index batch ${ci + 1} attempt ${attempt + 1} failed validation`);
        }

        if (!batchSuccess) {
            console.warn(`[SaveFileEngine] Header Index batch ${ci + 1} failed all retries, continuing with current index`);
        }
    }

    return { headerIndex: runningIndex, success: anySuccess };
}

// ─── Full Pipeline ───

export async function runSaveFilePipeline(
    provider: ProviderConfig | EndpointConfig,
    recentMessages: ChatMessage[],
    context: GameContext
): Promise<{ headerIndex: string; indexSuccess: boolean }> {
    const indexResult = await generateHeaderIndex(provider, recentMessages, context.headerIndex);
    return {
        headerIndex: indexResult.headerIndex,
        indexSuccess: indexResult.success,
    };
}

// ─── Chapter Summary Generator ───

const CHAPTER_SUMMARY_TOKEN_BUDGET = 8000;

export type ChapterSummaryOutput = {
    title: string;
    summary: string;
    keywords: string[];
    npcs: string[];
    majorEvents: string[];
    unresolvedThreads: string[];
    tone: string;
    themes: string[];
};

function truncateScenesToBudget(
    scenes: { sceneId: string; content: string }[],
    budget: number = CHAPTER_SUMMARY_TOKEN_BUDGET
): { sceneId: string; content: string }[] {
    // First pass: cap any single scene that exceeds the entire budget on its own
    const perSceneCap = Math.max(Math.floor(budget / Math.max(scenes.length, 1)), 500);
    let working = scenes.map(s => {
        if (countTokens(s.content) <= perSceneCap) return s;
        // ~4 chars per token approximation for the slice
        return { sceneId: s.sceneId, content: s.content.slice(0, perSceneCap * 4) + '\n[...truncated]' };
    });

    // Second pass: drop middle scenes until total fits the budget
    while (working.length > 1 && working.reduce((sum, s) => sum + countTokens(s.content), 0) > budget) {
        const mid = Math.floor(working.length / 2);
        working = [...working.slice(0, mid), ...working.slice(mid + 1)];
    }

    return working;
}

function buildChapterSummaryPrompt(
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string
): string {
    const truncated = truncateScenesToBudget(scenes);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');
    const sceneRangeStr = `${chapter.sceneRange[0]} to ${chapter.sceneRange[1]}`;

    return [
        'You are a TTRPG campaign archivist. Generate a structured chapter summary.',
        '',
        `CHAPTER: ${chapter.title || 'Untitled'}`,
        `SCENES: ${sceneRangeStr} (${chapter.sceneCount} scenes)`,
        '',
        'OUTPUT FORMAT — respond with a JSON object:',
        '{',
        '    "title": "Short evocative chapter title",',
        '    "summary": "4-8 bullet points covering key events, each on its own line starting with `- `",',
        '    "keywords": ["keyword1", "keyword2", ...],',
        '    "npcs": ["NPC Name 1", "NPC Name 2", ...],',
        '    "majorEvents": ["Event description 1", "Event description 2"],',
        '    "unresolvedThreads": ["Thread 1", "Thread 2"],',
        '    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",',
        '    "themes": ["theme1", "theme2"]',
        '}',
        '',
        'RULES:',
        '1. Keywords should be distinctive nouns/places/factions — not generic words',
        '2. NPCs should include all significant named characters who appeared or were discussed',
        '3. Major events are plot-critical beats only (not every combat round)',
        '4. Unresolved threads are open plot hooks, promises, or mysteries',
        '5. Title should be 2-5 words, evocative',
        '6. Summary should read like a campaign journal entry, not a list',
        '',
        'HEADER INDEX REFERENCE (for thread tracking):',
        headerIndex.slice(0, 2000), // Truncate header index if very long
        '',
        'SCENE CONTENT:',
        sceneContent,
    ].join('\n');
}

/**
 * Extract JSON from LLM output, handling markdown fences and common errors.
 */
export function parseChapterSummaryOutput(raw: string): ChapterSummaryOutput | null {
    const cleaned = extractJson(raw.trim());

    try {
        const parsed = JSON.parse(cleaned);

        // Validate required fields
        const required: (keyof ChapterSummaryOutput)[] = [
            'title', 'summary', 'keywords', 'npcs',
            'majorEvents', 'unresolvedThreads', 'tone', 'themes'
        ];

        for (const field of required) {
            if (!(field in parsed)) {
                console.warn(`[ChapterSummary] Missing field: ${field}`);
                parsed[field] = field === 'summary' || field === 'tone' ? '' : [];
            }
        }

        if (Array.isArray(parsed.summary)) parsed.summary = parsed.summary.join('\n');
        if (Array.isArray(parsed.tone)) parsed.tone = parsed.tone.join(', ');

        return parsed as ChapterSummaryOutput;
    } catch (e) {
        console.error('[ChapterSummary] Failed to parse JSON:', e);
        return null;
    }
}

export async function generateChapterSummary(
    provider: ProviderConfig | EndpointConfig,
    chapter: ArchiveChapter,
    scenes: { sceneId: string; content: string }[],
    headerIndex: string,
    maxRetries = 1
): Promise<ChapterSummaryOutput | null> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = attempt === 0
            ? buildChapterSummaryPrompt(chapter, scenes, headerIndex)
            : buildChapterSummaryPrompt(chapter, scenes, headerIndex) +
            '\n\nPREVIOUS ATTEMPT FAILED. Output ONLY valid JSON with all required fields.';

        console.log(`[SaveFileEngine] Generating Chapter Summary... (Attempt ${attempt + 1})`, {
            chapterId: chapter.chapterId,
            sceneCount: scenes.length,
            promptTokens: countTokens(prompt)
        });

        const output = await callLLM(provider, prompt, { priority: 'low' });
        const result = parseChapterSummaryOutput(output);

        if (result) {
            return result;
        }
        console.warn(`[SaveFileEngine] Chapter Summary attempt ${attempt + 1} failed parsing`);
    }

    return null;
}

// ─── Combined Seal Call (summary + divergences in ONE LLM call) ───

const COMBINED_SEAL_TOKEN_BUDGET = 12000;

export type CombinedSealResult = {
    summary: ChapterSummaryOutput | null;
    divergences: DivergenceEntry[];
    divergenceParseError?: boolean;
    witnessCorrections?: Record<string, string[]>;
};

function buildCombinedSealPrompt(
    scenes: { sceneId: string; content: string }[],
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    indexEntries?: { sceneId: string; witnesses?: string[] }[]
): string {
    const truncated = truncateScenesToBudget(scenes, COMBINED_SEAL_TOKEN_BUDGET);
    const sceneContent = truncated.map(s => `--- SCENE ${s.sceneId} ---\n${s.content}`).join('\n\n');

    const npcList = npcLedger.map(n =>
        `- ${n.name} (id: ${n.id}${n.aliases ? ', also known as: ' + n.aliases : ''})`
    ).join('\n');

    const divergenceSlots = DIVERGENCE_CATEGORIES.filter(c => c !== 'misc').map(c =>
        `### ${c.toUpperCase()}\nDefinition: ${CATEGORY_DEFINITIONS[c]}\nOutput: JSON array for this slot, or [] if empty.`
    ).join('\n\n');

    let witnessAuditSection = '';
    if (indexEntries && indexEntries.length > 0) {
        const entriesWithWitness = indexEntries.filter(e => e.witnesses && e.witnesses.length > 0);
        if (entriesWithWitness.length > 0) {
            const rows = entriesWithWitness.map(e =>
                `Scene ${e.sceneId}: ${(e.witnesses ?? []).join(', ') || '(none recorded)'}`
            ).join('\n');
            witnessAuditSection = `

AUDIT — PER-SCENE NPC WITNESSES (pre-capture):
The following per-scene witness data was captured during play. Review it for accuracy.
If you find that a scene's witnesses are incorrect (NPCs listed who were NOT present, or NPCs present who are NOT listed),
provide corrections in the "witness_corrections" field.

${rows}`;
        }
    }

    return `You are a TTRPG campaign archivist. Perform TWO tasks in a single response:

TASK 1 — Generate a structured chapter summary.
TASK 2 — Extract established facts that would BREAK A FUTURE SCENE if the AI contradicted them.

CHAPTER: "${chapterTitle || 'Untitled'}"
SCENE IDs IN THIS CHAPTER: ${sceneIds.join(', ')}

NPC LEDGER (resolve names to IDs):
${npcList || '(no NPCs in ledger)'}

SCENE CONTENT:
${sceneContent}
${witnessAuditSection}

${witnessAuditSection ? 'OUTPUT FORMAT — a single JSON object with two or three top-level keys: "summary", "divergences", and optionally "witness_corrections" (if you found errors in the per-scene witness data above).' : 'OUTPUT FORMAT — a single JSON object with exactly two top-level keys: "summary" and "divergences".'}

The "summary" value must be this JSON shape:
{
    "title": "Short evocative chapter title",
    "summary": "3-5 sentence narrative summary of what happened",
    "keywords": ["keyword1", "keyword2"],
    "npcs": ["NPC Name 1", "NPC Name 2"],
    "majorEvents": ["Event description 1", "Event description 2"],
    "unresolvedThreads": ["Thread 1", "Thread 2"],
    "tone": "one of: combat-heavy, exploration, social, mystery, political, emotional, mixed",
    "themes": ["theme1", "theme2"]
}

The "divergences" value must be an object with one key per category slot. Each value is an array of fact objects, or [] if empty. Example:
{
    "locations": [
        { "text": "Eastern gate destroyed by siege", "sceneRef": "014", "npcIds": [], "knownBy": [], "unrecognizedNpcNames": [] }
    ],
    "npc_events": [
        { "text": "Grak allied with the player", "sceneRef": "018", "npcIds": ["npc_42"], "knownBy": ["npc_42"], "unrecognizedNpcNames": [] }
    ],
    "promises_debts": [],
    "world_state": [],
    "party_facts": [],
    "rules_lore": [],
    "misc": []
}
${witnessAuditSection ? `
WITNESS CORRECTIONS:
If you found errors in the per-scene witness data above, include a "witness_corrections" key at the top level of the JSON:
"witness_corrections": { "014": ["Aldric", "Borric"], "022": ["Morrigan"] }
This maps scene IDs to the CORRECT list of NPC NAMES who were physically present in that scene. Only include scenes where you disagree with the pre-captured data.` : ''}

Category definitions:

${divergenceSlots}

### MISC
Definition: ${CATEGORY_DEFINITIONS.misc}
Output: JSON array for this slot, or [] if empty.

DIVERGENCE EXTRACTION RULES:
- Each fact is ONE SHORT SENTENCE, max 15 words. No compound sentences, no explanations.
- sceneRef must be one of: ${sceneIds.join(', ')}
- npcIds: list the NPC ledger IDs mentioned. If a name appears that is NOT in the ledger, put it in unrecognizedNpcNames instead.
- knownBy: list the NPC ledger IDs of witnesses who SAW or PARTICIPATED in this event. Only include NPCs who were present when the fact happened. Omit this field for rules_lore and locations (those are broadcast knowledge). If unsure, omit knownBy.
- Focus on: permanent changes, new information, relationship shifts, acquisitions, losses, oaths, regime changes.
- Skip transient details, emotional narration, momentary states, and anything the archive would already surface.
- If a slot is empty, output [] for that slot.

SUMMARY RULES:
1. Keywords should be distinctive nouns/places/factions — not generic words
2. NPCs should include all significant named characters who appeared or were discussed
3. Major events are plot-critical beats only (not every combat round)
4. Unresolved threads are open plot hooks, promises, or mysteries
5. Title should be 2-5 words, evocative
6. Summary should read like a campaign journal entry, not a list`;
}

function extractWitnessCorrections(parsed: object): Record<string, string[]> | undefined {
    const p = parsed as Record<string, unknown>;
    const rawCorrections =
        p['witness_corrections'] ??
        ((p['divergences'] as Record<string, unknown> | undefined)?.['witness_corrections']);
    if (rawCorrections && typeof rawCorrections === 'object' && !Array.isArray(rawCorrections)) {
        const corrections: Record<string, string[]> = {};
        for (const [sceneId, value] of Object.entries(rawCorrections as Record<string, unknown>)) {
            if (Array.isArray(value) && value.every((v: unknown) => typeof v === 'string')) {
                corrections[sceneId] = value as string[];
            }
        }
        if (Object.keys(corrections).length > 0) {
            console.log(`[CombinedSeal] Extracted witness corrections for ${Object.keys(corrections).length} scenes`);
            return corrections;
        }
    }
    return undefined;
}

export function parseCombinedSealOutput(
    raw: string,
    chapterId: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[]
): CombinedSealResult {
    const cleaned = extractJson(raw);
    const sceneSet = new Set(sceneIds);
    const fallbackScene = sceneIds[0] ?? '000';
    const npcNameMap = new Map<string, string>();
    for (const npc of npcLedger) {
        npcNameMap.set(npc.name.toLowerCase(), npc.id);
        if (npc.aliases) {
            for (const alias of npc.aliases.split(',')) {
                npcNameMap.set(alias.trim().toLowerCase(), npc.id);
            }
        }
    }

    let parsed: { summary?: unknown; divergences?: unknown };
    let divergenceParseError = false;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        console.warn('[CombinedSeal] JSON parse failed, attempting summary-only fallback');
        const summaryOnly = parseChapterSummaryOutput(raw);
        return { summary: summaryOnly, divergences: [], divergenceParseError: true };
    }

    let summary: ChapterSummaryOutput | null = null;
    if (parsed.summary && typeof parsed.summary === 'object') {
        summary = parseChapterSummaryOutput(JSON.stringify(parsed.summary));
    } else {
        summary = parseChapterSummaryOutput(raw);
    }

    const entries: DivergenceEntry[] = [];
    if (parsed.divergences && typeof parsed.divergences === 'object') {
        const divObj = parsed.divergences as Record<string, unknown[]>;

        for (const category of DIVERGENCE_CATEGORIES) {
            const slotArr = divObj[category];
            if (!Array.isArray(slotArr)) continue;

            for (const item of slotArr) {
                if (!item || typeof item !== 'object') continue;
                const rawItem = item as Record<string, unknown>;
                const text = typeof rawItem.text === 'string' ? rawItem.text.trim() : '';
                if (!text) continue;

                const sceneRef = typeof rawItem.sceneRef === 'string' && sceneSet.has(rawItem.sceneRef)
                    ? rawItem.sceneRef
                    : fallbackScene;

                const rawNpcIds: string[] = Array.isArray(rawItem.npcIds) ? rawItem.npcIds.filter((id): id is string => typeof id === 'string') : [];
                const resolvedNpcIds: string[] = [];
                const unrecognized: string[] = Array.isArray(rawItem.unrecognizedNpcNames)
                    ? rawItem.unrecognizedNpcNames.filter((n): n is string => typeof n === 'string')
                    : [];

                for (const id of rawNpcIds) {
                    const found = npcLedger.some(n => n.id === id);
                    if (found) {
                        resolvedNpcIds.push(id);
                    } else {
                        unrecognized.push(id);
                    }
                }

                const stillUnrecognized: string[] = [];
                for (const name of unrecognized) {
                    const matched = npcNameMap.get(name.toLowerCase());
                    if (matched && !resolvedNpcIds.includes(matched)) {
                        resolvedNpcIds.push(matched);
                    } else {
                        stillUnrecognized.push(name);
                    }
                }

                const hasReviewFlag = stillUnrecognized.length > 0;

                let knownBy: string[] | undefined = undefined;
                if (Array.isArray(rawItem.knownBy)) {
                    const resolvedKnown: string[] = [];
                    for (const kb of rawItem.knownBy) {
                        if (typeof kb !== 'string') continue;
                        if (npcLedger.some(n => n.id === kb)) {
                            resolvedKnown.push(kb);
                        } else {
                            const nameMatch = npcNameMap.get(kb.toLowerCase());
                            if (nameMatch) {
                                if (!resolvedKnown.includes(nameMatch)) resolvedKnown.push(nameMatch);
                            }
                        }
                    }
                    if (resolvedKnown.length > 0) knownBy = resolvedKnown;
                }

                if (category === 'rules_lore' || category === 'locations') {
                    knownBy = undefined;
                }

                entries.push({
                    id: `div_${uid()}`,
                    chapterId,
                    category: coerceCategory(category),
                    text,
                    sceneRef,
                    npcIds: resolvedNpcIds,
                    knownBy,
                    pinned: false,
                    source: 'auto',
                    reviewFlag: hasReviewFlag || undefined,
                    unrecognizedNpcNames: stillUnrecognized.length > 0 ? stillUnrecognized : undefined,
                });
            }
        }
    } else {
        divergenceParseError = true;
    }

    const witnessCorrections = extractWitnessCorrections(parsed);

    return { summary, divergences: entries, divergenceParseError: divergenceParseError || undefined, witnessCorrections };
}

export async function sealChapterCombined(
    provider: ProviderConfig | EndpointConfig,
    scenes: { sceneId: string; content: string }[],
    chapterId: string,
    chapterTitle: string,
    sceneIds: string[],
    npcLedger: { id: string; name: string; aliases: string }[],
    maxRetries = 2,
    scanBudget = 0,
    indexEntries?: { sceneId: string; witnesses?: string[] }[]
): Promise<CombinedSealResult> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const prompt = buildCombinedSealPrompt(scenes, chapterTitle, sceneIds, npcLedger, indexEntries);
        const label = attempt === 0 ? '' : ' (retry)';

        console.log(`[CombinedSeal] Generating summary + divergences${label}...`, {
            sceneCount: scenes.length,
            sceneIds: sceneIds.length,
            promptTokens: countTokens(prompt),
        });

        const output = await callLLM(provider, prompt, { priority: 'low', maxTokens: scanBudget > 0 ? scanBudget : 2000 });
        const result = parseCombinedSealOutput(output, chapterId, sceneIds, npcLedger);

        if (result.summary && !result.divergenceParseError) {
            return result;
        }
        if (result.summary && result.divergenceParseError) {
            console.warn(`[CombinedSeal] Attempt ${attempt + 1}: summary OK but divergence parse failed — retrying divergences`);
            continue;
        }
        console.warn(`[CombinedSeal] Attempt ${attempt + 1} produced no usable output`);
    }

    return { summary: null, divergences: [], divergenceParseError: true };
}


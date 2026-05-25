import type { ChatMessage, NPCEntry } from '../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { useAppStore } from '../store/useAppStore';
import { api } from './apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';
import { rateImportance } from './importanceRater';
import { sealChapterCombined } from './saveFileEngine';
import { backgroundQueue } from './backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './chatEngine';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from './npcPressureTracker';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';
import { mergeSealEntries, EMPTY_REGISTER } from './divergenceRegister';
import { saveDivergenceRegister } from '../store/campaignStore';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*(.+)/i;

function parsePresentHeader(content: string): string[] | null {
    const match = content.match(PRESENT_HEADER_RE);
    if (!match) return null;
    return match[1].split(/[,;]/).map(n => n.trim()).filter(Boolean);
}

function resolveNPCIds(
    names: string[],
    npcLedger: NPCEntry[]
): string[] {
    const nameToId = new Map<string, string>();
    for (const npc of npcLedger) {
        const nameLower = npc.name.toLowerCase();
        nameToId.set(nameLower, npc.id);
        if (npc.aliases) {
            npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                .forEach(a => nameToId.set(a, npc.id));
        }
    }
    return names
        .map(n => nameToId.get(n.toLowerCase()))
        .filter((id): id is string => !!id);
}

export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[]
): Promise<void> {
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    const results = await Promise.allSettled([
        runArchiveTrack(state, callbacks, displayInput, lastAssistantContent, allMsgs, activeCampaignId),
        runNPCTrack(state, callbacks, lastAssistantContent, allMsgs, npcLedger, activeCampaignId),
        runPressureTrack(state, callbacks, displayInput, npcLedger, activeCampaignId, lastAssistantContent),
    ]);

    // ── On-Stage NPC Tracking ──
    const presentNames = parsePresentHeader(lastAssistantContent);
    if (presentNames && presentNames.length > 0) {
        const resolved = resolveNPCIds(presentNames, npcLedger);
        callbacks.setOnStageNpcIds?.(resolved);
    } else {
        callbacks.setOnStageNpcIds?.([]);
    }

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[PostTurn] Track failed:', r.reason);
        }
    }
}

async function runArchiveTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    activeCampaignId: string
): Promise<void> {
    let sceneImportance: number | undefined;
    const importanceProvider = state.getFreshProvider();
    if (importanceProvider) {
        try {
            sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistantContent, allMsgs);
            console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
        } catch (err) {
            console.warn('[ImportanceRater] Failed (non-fatal):', err);
        }
    }

    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent, sceneImportance);
    const appendedSceneId = appendData?.sceneId;
    if (!appendData) {
        console.warn('[PostTurn] Archive append returned no data — skipping archive refresh');
        return;
    }

    const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
        api.archive.getIndex(activeCampaignId),
        api.timeline.get(activeCampaignId),
        api.chapters.list(activeCampaignId),
    ]);
    callbacks.setArchiveIndex(freshIndex);
    callbacks.setTimeline?.(freshTimeline);
    state.setChapters(freshChapters);
    console.log(`[Archive] Appended scene #${appendedSceneId}`);

    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            state.setChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

            const sealProvider = state.getFreshProvider();
            if (sealProvider) {
                await runCombinedSeal(
                    sealProvider,
                    sealResult.sealedChapter,
                    activeCampaignId,
                    state,
                    callbacks,
                    true
                );
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const inventoryItems = state.getFreshContext().inventoryItems || [];
            const profileData = state.getFreshContext().characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };

            backgroundQueue.push('Profile-Scan', async () => {
                const newProfile = await scanCharacterProfile(bkProvider, state.getMessages(), profileData);
                callbacks.updateContext({
                    characterProfile: JSON.stringify(newProfile),
                    characterProfileData: newProfile,
                    characterProfileLastScene: sceneId,
                });
                const s = useAppStore.getState();
                if (s.activeCampaignId === activeCampaignId && 'setCharacterProfileData' in s) {
                    (s as any).setCharacterProfileData(newProfile);
                }
                console.log(`[Auto Bookkeeping] Profile updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));

            backgroundQueue.push('Inventory-Scan', async () => {
                const newItems = await scanInventory(bkProvider, state.getMessages(), inventoryItems);
                callbacks.updateContext({
                    inventory: newItems.map(it => `- ${it.qty > 1 ? `${it.qty}x ` : ''}${it.name}`).join('\n'),
                    inventoryItems: newItems,
                    inventoryLastScene: sceneId,
                });
                const s = useAppStore.getState();
                if (s.activeCampaignId === activeCampaignId && 'setInventoryItems' in s) {
                    (s as any).setInventoryItems(newItems);
                }
                console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
        }
    }
}

export async function runCombinedSeal(
    provider: { endpoint: string; apiKey: string; modelName: string; apiFormat?: string },
    chapter: import('../types').ArchiveChapter,
    activeCampaignId: string,
    state: TurnState,
    callbacks: TurnCallbacks,
    setSealedAt: boolean
): Promise<void> {
    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);
    const sceneIds = chapter.sceneIds?.length > 0
        ? chapter.sceneIds
        : Array.from({ length: endNum - startNum + 1 }, (_, i) =>
            String(startNum + i).padStart(3, '0')
        );

    const scenes = await api.archive.fetchScenes(activeCampaignId, sceneIds);
    const npcLedger = useAppStore.getState().npcLedger ?? [];
    const npcData = npcLedger.map(n => ({
        id: n.id,
        name: n.name,
        aliases: n.aliases,
    }));

    const archiveIndex = useAppStore.getState().archiveIndex ?? [];
    const indexEntries = archiveIndex
        .filter(e => {
            const sn = parseInt(e.sceneId, 10);
            return sn >= startNum && sn <= endNum && e.witnesses && e.witnesses.length > 0;
        })
        .map(e => ({ sceneId: e.sceneId, witnesses: e.witnesses }));

    const scanBudgetSetting = useAppStore.getState().settings.divergenceScanBudget ?? 0;
    const contextLimit = useAppStore.getState().settings.contextLimit ?? 4096;
    const effectiveScanBudget = scanBudgetSetting > 0 ? scanBudgetSetting : Math.round(contextLimit * 0.75);

    const result = await sealChapterCombined(
        provider,
        scenes,
        chapter.chapterId,
        chapter.title,
        sceneIds,
        npcData,
        2,
        effectiveScanBudget,
        indexEntries.length > 0 ? indexEntries : undefined
    );

    if (result.divergenceParseError && !result.summary && !result.divergences.length) {
        toast.error('Chapter seal produced no output. Try regenerating.');
        return;
    }

    if (result.divergenceParseError && result.divergences.length === 0) {
        toast.warn('Summary generated but facts extraction failed. You can regenerate to retry.');
    }

    if (result.summary) {
        const patch: Record<string, any> = {
            ...result.summary,
            invalidated: false,
            sceneIds,
        };
        if (setSealedAt) {
            // Auto-seal already sets sealedAt via server; just update content
        }
        await api.chapters.update(activeCampaignId, chapter.chapterId, patch);
    } else if (setSealedAt || result.divergences.length > 0) {
        // Even without summary, persist sceneIds
        await api.chapters.update(activeCampaignId, chapter.chapterId, { sceneIds } as any);
    }

    if (result.divergences.length > 0) {
        const currentSceneId = sceneIds[sceneIds.length - 1] ?? '';
        const liveRegister = useAppStore.getState().divergenceRegister ?? EMPTY_REGISTER;
        const merged = mergeSealEntries(liveRegister, result.divergences, currentSceneId);
        callbacks.setDivergenceRegister?.(merged);

        try {
            await saveDivergenceRegister(activeCampaignId, merged);
        } catch (e) {
            console.warn('[CombinedSeal] Failed to save divergence register:', e);
        }

        console.log(`[CombinedSeal] Chapter ${chapter.chapterId}: ${result.divergences.length} facts extracted`);
    }

    // ── Apply witness corrections from seal audit ──
    if (result.witnessCorrections && Object.keys(result.witnessCorrections).length > 0) {
        try {
            const corrections = result.witnessCorrections;
            const patchPayload: { sceneId: string; witnesses: string[]; witnessSource: string }[] = [];
            for (const [sceneId, names] of Object.entries(corrections)) {
                if (names.length > 0) {
                    patchPayload.push({ sceneId, witnesses: names, witnessSource: 'seal_correction' });
                }
            }
            if (patchPayload.length > 0) {
                await api.archive.patchWitnesses(activeCampaignId, patchPayload);
                const freshIndex = await api.archive.getIndex(activeCampaignId);
                callbacks.setArchiveIndex(freshIndex);
                console.log(`[CombinedSeal] Applied witness corrections for ${Object.keys(corrections).length} scenes`);
            }
        } catch (e) {
            console.warn('[CombinedSeal] Failed to apply witness corrections:', e);
        }
    }

    const latestChapters = await api.chapters.list(activeCampaignId);
    state.setChapters(latestChapters);

    if (result.summary) {
        console.log(`[CombinedSeal] Summary generated for "${chapter.title}"`);
    }
}

async function runNPCTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    npcLedger: import('../types').NPCEntry[],
    activeCampaignId: string
): Promise<void> {
    const extractedNames = extractNPCNames(lastAssistantContent);
    if (extractedNames.length === 0) return;

    const freshProvider = state.getFreshProvider();
    const validatedNames = freshProvider
        ? await validateNPCCandidates(freshProvider, extractedNames, lastAssistantContent)
        : extractedNames;

    if (validatedNames.length === 0) return;

    const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);

    const guardedAddNPC = (npc: Parameters<typeof callbacks.addNPC>[0]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Auto-Gen] Dropping NPC "${npc.name}" — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        callbacks.addNPC(npc);
    };

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Update] Dropping update for NPC ${id} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        callbacks.updateNPC(id, patch);
    };

    for (const potentialName of newNames) {
        console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — queuing background profile generation...`);
        const genProvider = state.getFreshProvider();
        if (genProvider) {
            backgroundQueue.push(
                `NPC-Gen:${potentialName}`,
                () => generateNPCProfile(genProvider, allMsgs, potentialName, guardedAddNPC)
            ).catch(err => console.warn(`[NPC Auto-Gen] Background generation failed for "${potentialName}":`, err));
        }
    }

    if (existingNpcsToUpdate.length > 0) {
        const updateProvider = state.getFreshProvider();
        if (updateProvider) {
            backgroundQueue.push(
                `NPC-Update:${existingNpcsToUpdate.map(n => n.name).join(',')}`,
                () => updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, guardedUpdateNPC)
            ).catch(err => console.warn('[NPC Update] Background update failed:', err));
        }

        const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
        if (npcsNeedingDrives.length > 0) {
            const backfillProvider = state.getFreshProvider();
            if (backfillProvider) {
                backgroundQueue.push(
                    `NPC-Drives-Backfill:${npcsNeedingDrives.map(n => n.name).join(',')}`,
                    () => backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC)
                ).catch(err => console.warn('[NPC Drives Backfill] Background backfill failed:', err));
            }
        }
    }
}

async function runPressureTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    npcLedger: import('../types').NPCEntry[],
    activeCampaignId: string,
    lastAssistantContent: string
): Promise<void> {
    if (!npcLedger || npcLedger.length === 0) return;

    const archiveIndex = state.archiveIndex;
    const sceneNumber = archiveIndex.length > 0
        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    const loreHeadersSet = new Set<string>();
    if (state.loreChunks) {
        for (const chunk of state.loreChunks) {
            if (chunk.header) loreHeadersSet.add(chunk.header.toLowerCase());
        }
    }
    const activeNPCs = npcLedger.filter(npc => {
        if (npc.archived) return false;
        if (!npc.name) return false;
        if (loreHeadersSet.has(npc.name.toLowerCase())) return false;
        return true;
    });

    if (activeNPCs.length === 0) return;

    const updates = scanPressure(displayInput, activeNPCs);
    if (updates.length === 0) return;

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) return;
        callbacks.updateNPC(id, patch);
    };

    for (const update of updates) {
        const npc = npcLedger.find(n => n.id === update.npcId);
        if (!npc) continue;

        const patch = buildPressurePatch(npc, update, sceneNumber);
        guardedUpdateNPC(npc.id, patch);

        if (update.reasons.length > 0) {
            console.log(`[PressureTracker] ${npc.name}: ignored=${patch.pressure?.ignored?.toFixed(1)}, engaged=${patch.pressure?.engaged?.toFixed(1)} — ${update.reasons.join(', ')}`);
        }
    }

    // ── Auto-archive stale NPCs ──
    const maxStaleTurns = useAppStore.getState().settings.autoArchiveStaleNPCsTurns ?? 0;
    const currentTurn = archiveIndex.length;
    if (maxStaleTurns > 0) {
        const guardedArchiveNPC = (id: string, turn: number, reason: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.archiveNPC(id, turn, reason);
        };

        for (const npc of activeNPCs) {
            const result = shouldArchiveNPC(npc, currentTurn, maxStaleTurns);
            if (result.shouldArchive) {
                guardedArchiveNPC(npc.id, currentTurn, result.reason);
                console.log(`[Auto-Archive] ${npc.name} archived after ${result.turnsSince} turns inactive`);
            }
        }
    }

    // ── Auto-restore archived NPCs mentioned in the response ──
    const archivedNPCs = npcLedger.filter(n => n.archived);
    if (archivedNPCs.length > 0) {
        const toRestore = findArchivedToRestore(lastAssistantContent, archivedNPCs);
        const guardedRestoreNPC = (id: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.restoreNPC(id);
        };

        for (const npcId of toRestore) {
            const npc = npcLedger.find(n => n.id === npcId);
            guardedRestoreNPC(npcId);
            if (npc) {
                console.log(`[Auto-Restore] ${npc.name} re-enters the scene`);
                toast.info(`${npc.name} re-enters the scene`);
            }
        }
    }
}
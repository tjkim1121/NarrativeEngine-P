import type { AppSettings, ArchiveChapter, ArchiveIndexEntry, SemanticFact, EntityEntry, BackupMeta, TimelineEvent } from '../types';

import { API_BASE as API } from '../lib/apiBase';

export const api = {
    archive: {
        async append(campaignId: string, userText: string, assistantText: string, importance?: number, utilityConfig?: { endpoint: string; apiKey: string; model: string }): Promise<{ sceneId: string } | undefined> {
            try {
                const body: Record<string, unknown> = { userContent: userText, assistantContent: assistantText };
                if (importance !== undefined) body.importance = importance;
                if (utilityConfig) body.utilityConfig = utilityConfig;
                const res = await fetch(`${API}/campaigns/${campaignId}/archive`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (res.ok) {
                    return await res.json();
                }
            } catch (err) {
                console.warn('[Archive] Failed to append:', err);
            }
            return undefined;
        },
        async getIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/index`);
            if (res.ok) return await res.json();
            return [];
        },
        async deleteFrom(campaignId: string, sceneId: string): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/archive/scenes-from/${sceneId}`, {
                method: 'DELETE'
            });
        },
        async clear(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to clear archive');
        },
        async open(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/open`);
            if (!res.ok) {
                const data = await res.json();
                console.warn('[Archive]', data.error || 'Failed to open');
            }
        },
        async fetchScenes(campaignId: string, sceneIds: string[]): Promise<{ sceneId: string; content: string }[]> {
            if (sceneIds.length === 0) return [];
            const idsParam = sceneIds.join(',');
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/scenes?ids=${idsParam}`);
            if (!res.ok) throw new Error('Failed to fetch scenes');
            return res.json();
        },
        async patchWitnesses(campaignId: string, patches: { sceneId: string; witnesses: string[]; witnessSource: string }[]): Promise<void> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/witnesses`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ patches }),
                });
                if (!res.ok) {
                    console.warn('[Archive] Failed to patch witnesses:', res.status);
                }
            } catch (err) {
                console.warn('[Archive] Failed to patch witnesses:', err);
            }
        },
    },
    chapters: {
        async list(campaignId: string): Promise<ArchiveChapter[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`);
            if (res.ok) return await res.json();
            return [];
        },
        async create(campaignId: string, body?: { title?: string }): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to create:', err);
            }
            return undefined;
        },
        async update(campaignId: string, chapterId: string, body: Partial<ArchiveChapter>): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to update:', err);
            }
            return undefined;
        },
        async seal(campaignId: string, title?: string): Promise<{ sealedChapter: ArchiveChapter; newOpenChapter: ArchiveChapter } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/seal`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to seal:', err);
            }
            return undefined;
        },
        async merge(campaignId: string, chapterIdA: string, chapterIdB: string): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/merge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chapterIdA, chapterIdB }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to merge:', err);
            }
            return undefined;
        },
        async split(campaignId: string, chapterId: string, atSceneId: string): Promise<{ chapterA: ArchiveChapter, chapterB: ArchiveChapter } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}/split`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ atSceneId }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to split:', err);
            }
            return undefined;
        }
    },
    facts: {
        async get(campaignId: string): Promise<SemanticFact[]> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/facts`);
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Facts] Failed to fetch:', err);
            }
            return [];
        },
    },
    timeline: {
        async get(campaignId: string): Promise<TimelineEvent[]> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/timeline`);
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Timeline] Failed to fetch:', err);
            }
            return [];
        },
        async add(campaignId: string, event: Omit<TimelineEvent, 'id' | 'source'> & { source?: TimelineEvent['source'] }): Promise<TimelineEvent | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/timeline`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...event, object: event.object }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Timeline] Failed to add event:', err);
            }
            return undefined;
        },
        async remove(campaignId: string, eventId: string): Promise<boolean> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/timeline/${eventId}`, {
                    method: 'DELETE',
                });
                return res.ok;
            } catch (err) {
                console.warn('[Timeline] Failed to remove event:', err);
                return false;
            }
        },
    },
    entities: {
        async get(campaignId: string): Promise<EntityEntry[]> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/entities`);
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Entities] Failed to fetch:', err);
            }
            return [];
        },
        async merge(campaignId: string, survivorId: string, consumedId: string): Promise<boolean> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/entities/merge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ survivorId, consumedId }),
                });
                return res.ok;
            } catch (err) {
                console.warn('[Entities] Failed to merge:', err);
                return false;
            }
        },
    },
    campaigns: {} as Record<string, never>,
    settings: {
        async get(): Promise<any> {
            const res = await fetch(`${API}/settings`);
            if (!res.ok) throw new Error('Failed to load settings');
            return await res.json();
        },
        async save(settings: AppSettings, activeCampaignId: string | null): Promise<void> {
            await fetch(`${API}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings, activeCampaignId }),
            });
        }
    },
    backups: {
        async create(campaignId: string, opts: { label?: string; trigger?: string; isAuto?: boolean } = {}): Promise<any> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts),
            });
            if (res.ok) return await res.json();
            return undefined;
        },
        async list(campaignId: string): Promise<BackupMeta[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups`);
            if (res.ok) {
                const data = await res.json();
                return data.backups || [];
            }
            return [];
        },
        async restore(campaignId: string, timestamp: number): Promise<boolean> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}/restore`, {
                method: 'POST',
            });
            return res.ok;
        },
        async remove(campaignId: string, timestamp: number): Promise<boolean> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, {
                method: 'DELETE',
            });
            return res.ok;
        },
    },
    vault: {
        async status(): Promise<{ exists: boolean; unlocked: boolean; hasRemember: boolean }> {
            const res = await fetch(`${API}/vault/status`);
            if (!res.ok) throw new Error('Failed to get vault status');
            return await res.json();
        },
        async setup(password: string | null, presets: any[]): Promise<void> {
            const res = await fetch(`${API}/vault/setup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, presets }),
            });
            if (!res.ok) throw new Error('Failed to create vault');
        },
        async unlock(password: string, remember: boolean): Promise<void> {
            const res = await fetch(`${API}/vault/unlock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password, remember }),
            });
            if (!res.ok) throw new Error('Invalid password');
        },
        async unlockWithRemembered(): Promise<void> {
            const res = await fetch(`${API}/vault/unlock-remembered`, {
                method: 'POST',
            });
            if (!res.ok) throw new Error('Failed to unlock with remembered key');
        },
        async lock(): Promise<void> {
            await fetch(`${API}/vault/lock`, { method: 'POST' });
        },
        async getKeys(): Promise<{ presets: any[] }> {
            const res = await fetch(`${API}/vault/keys`);
            if (!res.ok) throw new Error('Vault is locked');
            return await res.json();
        },
        async saveKeys(data: { presets: any[] }): Promise<void> {
            const res = await fetch(`${API}/vault/keys`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data),
            });
            if (!res.ok) throw new Error('Failed to save keys');
        },
        async export(password: string): Promise<Blob> {
            const res = await fetch(`${API}/vault/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password }),
            });
            if (!res.ok) throw new Error('Failed to export vault');
            return await res.blob();
        },
        async import(file: string, password: string, merge: boolean = true): Promise<void> {
            const res = await fetch(`${API}/vault/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file, password, merge }),
            });
            if (!res.ok) throw new Error('Failed to import vault');
        },
        async clearRemembered(): Promise<void> {
            await fetch(`${API}/vault/remember`, { method: 'DELETE' });
        },
        async delete(): Promise<void> {
            await fetch(`${API}/vault`, { method: 'DELETE' });
        },
    },
};

import { useAppStore } from '../../store/useAppStore';
import { OverworldCanvas } from './OverworldCanvas';
import { Loader2, Map, X, RotateCcw, MapPin } from 'lucide-react';
import type { GameContext } from '../../types';

function hasValidCells(map: { cells?: unknown[]; width?: number; height?: number } | null): boolean {
    return !!(map && map.cells && map.cells.length > 0 && map.width && map.height);
}

function buildLoreText(loreChunks: { header: string; content: string }[], worldVibe: string): string {
    const parts = loreChunks.map(c => `${c.header}: ${c.content}`).join('\n');
    return parts || worldVibe || '';
}

export function MapPanel() {
    const isMapOpen = useAppStore(s => s.isMapOpen);
    const toggleMap = useAppStore(s => s.toggleMap);
    const overworldMap = useAppStore(s => s.overworldMap);
    const isMapLoading = useAppStore(s => s.isMapLoading);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const loreChunks = useAppStore(s => s.loreChunks);
    const context = useAppStore(s => s.context);
    const generateMap = useAppStore(s => s.generateMap);
    const loadMap = useAppStore(s => s.loadMap);
    const setOverworldMap = useAppStore(s => s.setOverworldMap);
    const playerPosition = useAppStore(s => s.playerPosition);
    const isPinMode = useAppStore(s => s.isPinMode);
    const togglePinMode = useAppStore(s => s.togglePinMode);

    const validMap = hasValidCells(overworldMap);

    const handleGenerate = async () => {
        if (!activeCampaignId) return;
        const endpoint = useAppStore.getState().getActiveStoryEndpoint();
        if (!endpoint) {
            alert('No LLM endpoint configured. Set up a preset in Settings first.');
            return;
        }
        const lore = buildLoreText(loreChunks, context.worldVibe);
        try {
            await generateMap(
                activeCampaignId,
                lore,
                { endpoint: endpoint.endpoint, apiKey: endpoint.apiKey, model: endpoint.modelName },
            );
        } catch (err) {
            console.error('[MapPanel] Generate failed:', err);
            alert('Failed to generate world map. Check your LLM configuration.');
        }
    };

    const handleLoadMap = async () => {
        if (!activeCampaignId) return;
        await loadMap(activeCampaignId);
    };

    const handleReset = () => {
        setOverworldMap(null);
    };

    return (
        <>
            {!isMapOpen && (
                <button
                    onClick={() => {
                        toggleMap();
                        if (activeCampaignId && !overworldMap) {
                            handleLoadMap();
                        }
                    }}
                    className="fixed top-14 right-3 z-50 flex items-center gap-1.5 px-3 py-1.5 text-[10px] uppercase tracking-widest font-bold transition-all border bg-void border-border text-text-dim hover:text-terminal hover:border-terminal/50"
                    title="Open Map"
                >
                    <Map size={13} />
                    Map
                </button>
            )}

            <div
                className={`fixed top-12 right-0 h-[calc(100vh-3rem)] bg-void border-l border-border z-40 transition-transform duration-300 ease-in-out flex flex-col ${
                    isMapOpen ? 'translate-x-0 w-[60vw]' : 'translate-x-full w-0'
                }`}
            >
                {isMapOpen && (
                    <>
                        <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface flex-shrink-0">
                            <span className="text-text-dim text-[10px] uppercase tracking-widest font-bold">
                                World Map
                            </span>
                            <div className="flex items-center gap-2">
                                <label className="text-[9px] text-text-dim/60 uppercase tracking-wider">Vibe</label>
                                <input
                                    type="text"
                                    value={context.worldVibe ?? ''}
                                    onChange={(e) => useAppStore.getState().updateContext({ worldVibe: e.target.value } as Partial<GameContext>)}
                                    placeholder="e.g. Grimdark Fantasy..."
                                    className="w-40 bg-surface border border-border px-2 py-0.5 text-[10px] font-mono text-text-primary focus:border-terminal outline-none transition-colors"
                                />
                            </div>
                            <div className="flex items-center gap-3">
                                {overworldMap && (
                                    <span className="text-text-dim/60 text-[9px] font-mono">
                                        ({playerPosition.x}, {playerPosition.y}) &middot; {overworldMap.width}x{overworldMap.height}
                                    </span>
                                )}
                                {overworldMap && (
                                    <button
                                        onClick={togglePinMode}
                                        className={`transition-colors text-[9px] uppercase tracking-widest font-bold flex items-center gap-1 px-2 py-0.5 border ${
                                            isPinMode
                                                ? 'border-terminal/60 text-terminal bg-terminal/10'
                                                : 'border-transparent text-text-dim/40 hover:text-text-dim'
                                        }`}
                                        title={isPinMode ? 'Click map to place pin (Esc to cancel)' : 'Add map pin'}
                                    >
                                        <MapPin size={10} />
                                        {isPinMode ? 'Placing…' : 'Pin'}
                                    </button>
                                )}
                                <button
                                    onClick={handleReset}
                                    className="text-text-dim/40 hover:text-danger transition-colors"
                                    title="Reset map"
                                >
                                    <RotateCcw size={12} />
                                </button>
                                <button
                                    onClick={toggleMap}
                                    className="text-text-dim hover:text-terminal transition-colors"
                                    title="Close Map"
                                >
                                    <X size={14} />
                                </button>
                            </div>
                        </div>

                        <div className="flex-1 relative overflow-hidden">
                            {isMapLoading && (
                                <div className="absolute inset-0 flex items-center justify-center bg-void/80 z-10">
                                    <div className="flex flex-col items-center gap-3">
                                        <Loader2 size={24} className="animate-spin text-terminal" />
                                        <span className="text-terminal text-[11px] uppercase tracking-widest animate-pulse">
                                            Generating world...
                                        </span>
                                    </div>
                                </div>
                            )}

                            {validMap ? (
                                <OverworldCanvas />
                            ) : (
                                <div className="flex items-center justify-center h-full">
                                    <div className="text-center space-y-4">
                                        <Map size={48} className="mx-auto text-text-dim/30" />
                                        <p className="text-text-dim text-xs uppercase tracking-widest">
                                            {overworldMap ? 'Map data is empty — regenerate' : 'No world map generated yet'}
                                        </p>
                                        <button
                                            onClick={handleGenerate}
                                            disabled={isMapLoading}
                                            className="bg-terminal/20 border border-terminal/50 text-terminal text-[10px] uppercase tracking-widest font-bold px-6 py-2 hover:bg-terminal/30 transition-colors disabled:opacity-50"
                                        >
                                            Generate World Map
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>
        </>
    );
}

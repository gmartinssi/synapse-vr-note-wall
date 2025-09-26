import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  Controls,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
} from 'reactflow';
import 'reactflow/dist/style.css';
import Dexie from 'dexie';
import { create } from 'zustand';

const db = new Dexie('SynapseDB');
db.version(1).stores({ canvasState: 'id' });

const DEFAULT_NOTE_SIZE = { width: 320, height: 220 };
const MIN_NOTE_SIZE = { width: 200, height: 160 };
const MAX_NOTE_SIZE = { width: 520, height: 460 };

const makeId = () => `n-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const ensureNodeShape = (node, fallbackZ = 1) => {
  const data = node?.data ?? {};
  const width = clamp(Number(data.width) || DEFAULT_NOTE_SIZE.width, MIN_NOTE_SIZE.width, MAX_NOTE_SIZE.width);
  const height = clamp(Number(data.height) || DEFAULT_NOTE_SIZE.height, MIN_NOTE_SIZE.height, MAX_NOTE_SIZE.height);
  const zIndex = Number.isFinite(data.zIndex) ? data.zIndex : fallbackZ;

  return {
    type: 'sticky',
    ...node,
    data: {
      text: '',
      ...data,
      width,
      height,
      zIndex,
    },
    style: {
      borderRadius: 18,
      width,
      height,
      zIndex,
      ...(node?.style ?? {}),
    },
  };
};

const sanitizeNodeForSave = (node) => {
  const hydrated = ensureNodeShape(node);
  return {
    id: hydrated.id,
    type: hydrated.type,
    position: hydrated.position,
    positionAbsolute: hydrated.positionAbsolute,
    data: hydrated.data,
    style: hydrated.style,
  };
};

const computeOverlapRatio = (a, b) => {
  if (!a || !b) return 0;
  const widthA = a.data?.width ?? DEFAULT_NOTE_SIZE.width;
  const heightA = a.data?.height ?? DEFAULT_NOTE_SIZE.height;
  const widthB = b.data?.width ?? DEFAULT_NOTE_SIZE.width;
  const heightB = b.data?.height ?? DEFAULT_NOTE_SIZE.height;

  const ax1 = a.position?.x ?? 0;
  const ay1 = a.position?.y ?? 0;
  const ax2 = ax1 + widthA;
  const ay2 = ay1 + heightA;

  const bx1 = b.position?.x ?? 0;
  const by1 = b.position?.y ?? 0;
  const bx2 = bx1 + widthB;
  const by2 = by1 + heightB;

  const overlapX = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
  const overlapY = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const overlap = overlapX * overlapY;
  if (!overlap) return 0;

  const areaA = widthA * heightA;
  const areaB = widthB * heightB;
  const smallestArea = Math.max(1, Math.min(areaA, areaB));

  return overlap / smallestArea;
};

const debounce = (fn, delay) => {
  let timer;
  const debounced = (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      fn(...args);
    }, delay);
  };
  debounced.cancel = () => window.clearTimeout(timer);
  return debounced;
};

const useCanvasStore = create((set, get) => ({
  nodes: [],
  edges: [],
  highestZ: 1,
  mergePair: null,
  contextMenu: null,
  isSettingsOpen: false,
  setNodes: (updater) =>
    set((state) => {
      const nextNodes = typeof updater === 'function' ? updater(state.nodes) : updater;
      const hydrated = nextNodes.map((node) => ensureNodeShape(node, state.highestZ));
      const highestZ = hydrated.reduce((max, node) => Math.max(max, node.data?.zIndex ?? 1, max), state.highestZ);
      return { nodes: hydrated, highestZ };
    }),
  setEdges: (updater) =>
    set((state) => ({
      edges: typeof updater === 'function' ? updater(state.edges) : updater,
    })),
  createNote: (position, options = {}) => {
    const nextZ = get().highestZ + 1;
    const node = ensureNodeShape(
      {
        id: options.id ?? makeId(),
        type: 'sticky',
        position,
        data: {
          text: options.text ?? '',
          width: options.width ?? DEFAULT_NOTE_SIZE.width,
          height: options.height ?? DEFAULT_NOTE_SIZE.height,
          zIndex: nextZ,
        },
      },
      nextZ,
    );
    set((state) => ({ nodes: [...state.nodes, node], highestZ: nextZ }));
    return node;
  },
  updateNoteData: (id, updater) =>
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== id) return node;
        const base = node.data ?? {};
        const patch = typeof updater === 'function' ? updater(base) : updater;
        const nextData = { ...base, ...patch };
        return ensureNodeShape({ ...node, data: nextData }, nextData.zIndex ?? state.highestZ);
      }),
    })),
  setNodeSize: (id, size) =>
    set((state) => ({
      nodes: state.nodes.map((node) => {
        if (node.id !== id) return node;
        const width = clamp(size.width, MIN_NOTE_SIZE.width, MAX_NOTE_SIZE.width);
        const height = clamp(size.height, MIN_NOTE_SIZE.height, MAX_NOTE_SIZE.height);
        const nextData = { ...node.data, width, height };
        return ensureNodeShape({ ...node, data: nextData }, nextData.zIndex ?? state.highestZ);
      }),
    })),
  setNodeDragging: (id, dragging) =>
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === id
          ? ensureNodeShape({ ...node, data: { ...node.data, dragging } }, node.data?.zIndex ?? state.highestZ)
          : node,
      ),
    })),
  deleteNote: (id) =>
    set((state) => ({
      nodes: state.nodes.filter((node) => node.id !== id),
      edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
      mergePair: state.mergePair && state.mergePair.ids.includes(id) ? null : state.mergePair,
      contextMenu: state.contextMenu?.nodeId === id ? null : state.contextMenu,
    })),
  bringToFront: (id) => {
    const nextZ = get().highestZ + 1;
    set((state) => ({
      highestZ: nextZ,
      nodes: state.nodes.map((node) =>
        node.id === id
          ? ensureNodeShape({ ...node, data: { ...node.data, zIndex: nextZ } }, nextZ)
          : node,
      ),
    }));
  },
  setMergePair: (pair) =>
    set(() => {
      if (!pair || !pair.ids || pair.ids.length < 2) {
        return { mergePair: null };
      }
      const ids = [...new Set(pair.ids.filter(Boolean))];
      if (ids.length < 2) {
        return { mergePair: null };
      }
      return { mergePair: { ids, triggeredBy: pair.triggeredBy ?? null } };
    }),
  clearMergePair: () => set({ mergePair: null }),
  setContextMenu: (menu) => set({ contextMenu: menu }),
  closeContextMenu: () => set({ contextMenu: null }),
  toggleSettings: () => set((state) => ({ isSettingsOpen: !state.isSettingsOpen })),
  closeSettings: () => set({ isSettingsOpen: false }),
  replaceState: ({ nodes = [], edges = [] }) => {
    const hydrated = nodes.map((node, idx) => ensureNodeShape(node, idx + 1));
    const highestZ = hydrated.reduce((max, node) => Math.max(max, node.data?.zIndex ?? 1, max), 1);
    set({
      nodes: hydrated,
      edges,
      highestZ,
      mergePair: null,
      contextMenu: null,
    });
  },
  mergeNotes: () => {
    const state = get();
    const pair = state.mergePair;
    if (!pair || pair.ids.length < 2) return;
    const [idA, idB] = pair.ids;
    const noteA = state.nodes.find((node) => node.id === idA);
    const noteB = state.nodes.find((node) => node.id === idB);
    if (!noteA || !noteB) {
      set({ mergePair: null });
      return;
    }

    const combinedText = [noteA.data?.text ?? '', noteB.data?.text ?? '']
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .join('\n\n---\n\n');

    const newPosition = {
      x: ((noteA.position?.x ?? 0) + (noteB.position?.x ?? 0)) / 2,
      y: ((noteA.position?.y ?? 0) + (noteB.position?.y ?? 0)) / 2,
    };

    const width = clamp(
      Math.max(noteA.data?.width ?? DEFAULT_NOTE_SIZE.width, noteB.data?.width ?? DEFAULT_NOTE_SIZE.width) + 32,
      MIN_NOTE_SIZE.width,
      MAX_NOTE_SIZE.width,
    );
    const height = clamp(
      Math.max(noteA.data?.height ?? DEFAULT_NOTE_SIZE.height, noteB.data?.height ?? DEFAULT_NOTE_SIZE.height) + 64,
      MIN_NOTE_SIZE.height,
      MAX_NOTE_SIZE.height,
    );

    const nextZ = state.highestZ + 1;
    const mergedNode = ensureNodeShape(
      {
        id: makeId(),
        type: 'sticky',
        position: newPosition,
        data: {
          text: combinedText,
          width,
          height,
          zIndex: nextZ,
        },
      },
      nextZ,
    );

    const removedIds = new Set([idA, idB]);
    const survivingNodes = state.nodes.filter((node) => !removedIds.has(node.id));

    const remappedEdges = [];
    const seenKeys = new Set();
    state.edges.forEach((edge) => {
      let source = edge.source;
      let target = edge.target;
      let changed = false;
      if (removedIds.has(source)) {
        source = mergedNode.id;
        changed = true;
      }
      if (removedIds.has(target)) {
        target = mergedNode.id;
        changed = true;
      }
      if (source === target) return;
      const key = `${source}-${target}`;
      if (changed) {
        if (seenKeys.has(key)) return;
        seenKeys.add(key);
        remappedEdges.push({ ...edge, id: `e-${makeId()}`, source, target });
        return;
      }
      remappedEdges.push(edge);
    });

    set({
      nodes: [...survivingNodes, mergedNode],
      edges: remappedEdges,
      highestZ: nextZ,
      mergePair: null,
    });
  },
}));

const StickyNoteNode = ({ id, data, selected }) => {
  const textareaRef = useRef(null);
  const longPressTimer = useRef();
  const startPoint = useRef(null);

  const updateNoteData = useCanvasStore((state) => state.updateNoteData);
  const bringToFront = useCanvasStore((state) => state.bringToFront);
  const deleteNote = useCanvasStore((state) => state.deleteNote);
  const setNodeSize = useCanvasStore((state) => state.setNodeSize);
  const closeContextMenu = useCanvasStore((state) => state.closeContextMenu);
  const mergePair = useCanvasStore((state) => state.mergePair);
  const mergeNotes = useCanvasStore((state) => state.mergeNotes);

  const isMergeCandidate = mergePair?.ids?.includes(id);
  const isDragging = Boolean(data?.dragging);

  useEffect(() => {
    if (data?.autoFocus && textareaRef.current) {
      textareaRef.current.focus();
      updateNoteData(id, { autoFocus: false });
    }
  }, [data?.autoFocus, id, updateNoteData]);

  const handleTextChange = (event) => {
    const value = event.target.value.slice(0, 2000);
    updateNoteData(id, { text: value });
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0) return;
    bringToFront(id);
    closeContextMenu();
    startPoint.current = { x: event.clientX, y: event.clientY };

    longPressTimer.current = window.setTimeout(() => {
      useCanvasStore.getState().setContextMenu({ nodeId: id, x: event.clientX, y: event.clientY });
    }, 550);

    const cancel = () => {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = undefined;
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointermove', handleMove);
    };

    const handleMove = (moveEvent) => {
      if (!startPoint.current) return;
      const deltaX = Math.abs(moveEvent.clientX - startPoint.current.x);
      const deltaY = Math.abs(moveEvent.clientY - startPoint.current.y);
      if (deltaX > 8 || deltaY > 8) {
        cancel();
      }
    };

    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointermove', handleMove);
  };

  const handleClick = (event) => {
    event.stopPropagation();
    bringToFront(id);
    if (isMergeCandidate) {
      mergeNotes();
    }
  };

  const handleDelete = (event) => {
    event.stopPropagation();
    deleteNote(id);
  };

  const handleResizeStart = (event) => {
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initialWidth = data?.width ?? DEFAULT_NOTE_SIZE.width;
    const initialHeight = data?.height ?? DEFAULT_NOTE_SIZE.height;

    const handlePointerMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      const nextWidth = initialWidth + deltaX;
      const nextHeight = initialHeight + deltaY;
      setNodeSize(id, { width: nextWidth, height: nextHeight });
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
  };

  const noteBorder = isMergeCandidate
    ? 'ring-4 ring-cyan-400'
    : selected || isDragging
    ? 'ring-4 ring-emerald-300'
    : 'ring-2 ring-slate-900/20';

  return (
    <div
      className={`relative flex h-full w-full flex-col rounded-2xl bg-amber-200/95 p-4 shadow-[0_20px_45px_rgba(15,23,42,0.35)] transition-transform duration-150 ${noteBorder}`}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-[0.25em] text-slate-700">Sticky Note</span>
          <span className="text-sm font-semibold text-slate-900 opacity-80">Tap + hold for tools</span>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          className="ml-2 flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/20 text-slate-900 transition hover:bg-rose-500 hover:text-white"
          aria-label="Delete note"
        >
          ×
        </button>
      </div>
      <textarea
        ref={textareaRef}
        className="mt-4 flex-1 resize-none rounded-xl bg-white/80 p-4 text-lg font-medium leading-relaxed text-slate-900 outline-none placeholder:text-slate-400"
        placeholder="Write your idea..."
        value={data?.text ?? ''}
        onChange={handleTextChange}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <div className="mt-3 flex items-center justify-between text-xs uppercase tracking-widest text-slate-600">
        <span>{Math.max(0, (data?.text ?? '').length)}/2000</span>
        <span>{Math.round((data?.width ?? DEFAULT_NOTE_SIZE.width) / 10)}×{Math.round((data?.height ?? DEFAULT_NOTE_SIZE.height) / 10)}</span>
      </div>
      <div
        role="presentation"
        onPointerDown={handleResizeStart}
        className="absolute bottom-2 right-2 flex h-10 w-10 cursor-se-resize items-center justify-center rounded-full bg-slate-900/30 text-white shadow-lg"
        aria-label="Resize note"
      >
        ⇲
      </div>
    </div>
  );
};

const nodeTypes = { sticky: StickyNoteNode };

const CanvasExperience = () => {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setNodes = useCanvasStore((state) => state.setNodes);
  const setEdges = useCanvasStore((state) => state.setEdges);
  const createNote = useCanvasStore((state) => state.createNote);
  const bringToFront = useCanvasStore((state) => state.bringToFront);
  const setMergePair = useCanvasStore((state) => state.setMergePair);
  const clearMergePair = useCanvasStore((state) => state.clearMergePair);
  const contextMenu = useCanvasStore((state) => state.contextMenu);
  const closeContextMenu = useCanvasStore((state) => state.closeContextMenu);
  const toggleSettings = useCanvasStore((state) => state.toggleSettings);
  const isSettingsOpen = useCanvasStore((state) => state.isSettingsOpen);
  const closeSettings = useCanvasStore((state) => state.closeSettings);

  const [importError, setImportError] = useState('');
  const fileInputRef = useRef(null);

  const { screenToFlowPosition } = useReactFlow();

  const adjustScreenPointForHUD = useCallback((point) => {
    const safePoint = { ...point };
    const hudPadding = 24;
    const hudWidth = 500;
    const hudHeight = 170;

    if (typeof window !== 'undefined') {
      safePoint.x = clamp(safePoint.x, hudPadding, window.innerWidth - hudPadding);
      safePoint.y = clamp(safePoint.y, hudPadding, window.innerHeight - hudPadding);
    }

    const insideHudWidth = safePoint.x >= hudPadding && safePoint.x <= hudPadding + hudWidth;
    const insideHudHeight = safePoint.y >= hudPadding && safePoint.y <= hudPadding + hudHeight;

    if (insideHudWidth && insideHudHeight) {
      safePoint.y = hudPadding + hudHeight + 140;
      safePoint.x = hudPadding + hudWidth + 80;
    } else if (safePoint.y < hudPadding + 60) {
      safePoint.y = hudPadding + 60;
    }

    if (typeof window !== 'undefined') {
      safePoint.x = clamp(safePoint.x, hudPadding, window.innerWidth - hudPadding);
      safePoint.y = clamp(safePoint.y, hudPadding, window.innerHeight - hudPadding);
    }

    return safePoint;
  }, []);

  const onNodesChange = useCallback(
    (changes) => {
      setNodes((current) => applyNodeChanges(changes, current));
    },
    [setNodes],
  );

  const onEdgesChange = useCallback(
    (changes) => {
      setEdges((current) => applyEdgeChanges(changes, current));
    },
    [setEdges],
  );

  const onConnect = useCallback(
    (connection) => {
      setEdges((eds) => addEdge({ ...connection, type: 'smoothstep', animated: false, style: { stroke: '#38bdf8', strokeWidth: 3 } }, eds));
    },
    [setEdges],
  );

  const createNoteAtPosition = useCallback(
    (position, options = {}) => {
      const node = createNote(position, { ...options, autoFocus: true });
      if (options.text !== undefined) {
        useCanvasStore.getState().updateNoteData(node.id, { text: options.text });
      }
      useCanvasStore.getState().updateNoteData(node.id, { autoFocus: true });
      bringToFront(node.id);
      return node;
    },
    [createNote, bringToFront],
  );

  const createNoteFromScreenPoint = useCallback(
    (screenPoint, options = {}) => {
      const safePoint = adjustScreenPointForHUD(screenPoint);
      const position = screenToFlowPosition(safePoint);
      return createNoteAtPosition(position, options);
    },
    [screenToFlowPosition, adjustScreenPointForHUD, createNoteAtPosition],
  );

  const handlePaneDoubleClick = useCallback(
    (event) => {
      clearMergePair();
      closeContextMenu();
      createNoteFromScreenPoint({ x: event.clientX, y: event.clientY }, { text: '' });
    },
    [clearMergePair, closeContextMenu, createNoteFromScreenPoint],
  );

  const handleNodeClick = useCallback(
    (_, node) => {
      bringToFront(node.id);
    },
    [bringToFront],
  );

  const handleNodeDragStart = useCallback(
    (_, node) => {
      bringToFront(node.id);
      clearMergePair();
      useCanvasStore.getState().setNodeDragging(node.id, true);
      closeContextMenu();
    },
    [bringToFront, clearMergePair, closeContextMenu],
  );

  const handleNodeDragStop = useCallback((_, node) => {
    useCanvasStore.getState().setNodeDragging(node.id, false);
    const state = useCanvasStore.getState();
    const dragged = state.nodes.find((item) => item.id === node.id);
    if (!dragged) {
      state.clearMergePair();
      return;
    }

    const overlaps = state.nodes
      .filter((other) => other.id !== dragged.id)
      .map((other) => ({ other, ratio: computeOverlapRatio(dragged, other) }))
      .filter(({ ratio }) => ratio >= 0.35)
      .sort((a, b) => b.ratio - a.ratio);

    if (overlaps.length > 0) {
      setMergePair({ ids: [dragged.id, overlaps[0].other.id], triggeredBy: dragged.id });
    } else if (state.mergePair?.ids?.includes(dragged.id)) {
      clearMergePair();
    }
  }, [setMergePair, clearMergePair]);

  const handlePaneClick = useCallback(() => {
    clearMergePair();
    closeContextMenu();
  }, [clearMergePair, closeContextMenu]);

  const handleCreateChild = useCallback(async () => {
    if (!contextMenu?.nodeId) return;
    const parent = useCanvasStore.getState().nodes.find((node) => node.id === contextMenu.nodeId);
    if (!parent) return;

    const offset = 80;
    const position = {
      x: (parent.position?.x ?? 0) + (parent.data?.width ?? DEFAULT_NOTE_SIZE.width) + offset,
      y: (parent.position?.y ?? 0) + 20,
    };

    const child = createNoteAtPosition(position, { text: '' });
    setEdges((edgesState) => [
      ...edgesState,
      {
        id: `e-${makeId()}`,
        source: parent.id,
        target: child.id,
        type: 'smoothstep',
        animated: false,
        style: { stroke: '#f97316', strokeWidth: 3 },
      },
    ]);
    closeContextMenu();
  }, [contextMenu, createNoteAtPosition, setEdges, closeContextMenu]);

  const handleExport = useCallback(() => {
    const snapshot = useCanvasStore.getState();
    const payload = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      nodes: snapshot.nodes.map(sanitizeNodeForSave),
      edges: snapshot.edges,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'synapse-project.json';
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleImportClick = useCallback(() => {
    setImportError('');
    fileInputRef.current?.click();
  }, []);

  const handleImport = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
        throw new Error('Invalid Synapse export file.');
      }
      useCanvasStore.getState().replaceState({ nodes: parsed.nodes, edges: parsed.edges });
      await db.canvasState.put({
        id: 'latest',
        nodes: parsed.nodes.map(sanitizeNodeForSave),
        edges: parsed.edges,
        savedAt: Date.now(),
      });
      setImportError('');
    } catch (error) {
      console.error(error);
      setImportError('Import failed. Please choose a valid synapse-project.json file.');
    }
  }, []);

  const defaultEdgeOptions = useMemo(
    () => ({ type: 'smoothstep', animated: false, style: { stroke: '#7dd3fc', strokeWidth: 3 } }),
    [],
  );

  return (
    <div className="h-full w-full">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={handleImport}
      />
      <div className="pointer-events-none absolute left-6 top-6 z-50 flex max-w-xl flex-col gap-2 rounded-2xl bg-slate-900/60 p-6 text-slate-100 backdrop-blur">
        <h1 className="text-3xl font-semibold tracking-wide">Synapse Wall</h1>
        <p className="text-lg leading-relaxed">
          Double-tap empty space to spawn notes, drag to move, hold to branch. Drop notes together to prepare a merge.
        </p>
      </div>
      <button
        type="button"
        onClick={() => toggleSettings()}
        className="absolute right-6 top-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-slate-900 text-slate-100 shadow-lg transition hover:bg-cyan-500"
        aria-label="Open settings"
      >
        ⚙️
      </button>
      {isSettingsOpen && (
        <div className="absolute right-6 top-24 z-50 w-80 rounded-3xl bg-slate-900/90 p-6 text-slate-100 backdrop-blur">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Canvas Settings</h2>
            <button
              type="button"
              onClick={closeSettings}
              className="rounded-full bg-slate-700 px-3 py-1 text-sm uppercase tracking-widest hover:bg-slate-600"
            >
              Close
            </button>
          </div>
          <div className="mt-4 space-y-4 text-sm">
            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wider text-slate-400">Data Export</label>
              <button
                type="button"
                onClick={handleExport}
                className="w-full rounded-xl bg-cyan-500 px-4 py-3 text-base font-semibold text-white transition hover:bg-cyan-400"
              >
                Export Project
              </button>
            </div>
            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wider text-slate-400">Data Import</label>
              <button
                type="button"
                onClick={handleImportClick}
                className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-base font-semibold text-white transition hover:bg-emerald-400"
              >
                Import Project
              </button>
              {importError && <p className="text-sm text-rose-300">{importError}</p>}
            </div>
            <div className="space-y-2">
              <label className="block text-xs uppercase tracking-wider text-slate-400">Ollama API Endpoint (coming soon)</label>
              <input
                type="text"
                value="http://100.113.82.99:11434"
                disabled
                className="w-full cursor-not-allowed rounded-xl bg-slate-800 px-4 py-3 text-base text-slate-400 opacity-60"
              />
            </div>
          </div>
        </div>
      )}
      {contextMenu && (
        <div
          className="absolute z-50 w-56 rounded-2xl bg-slate-900/90 p-4 text-slate-100 shadow-xl backdrop-blur"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <p className="text-sm uppercase tracking-widest text-slate-400">Note Actions</p>
          <button
            type="button"
            onClick={handleCreateChild}
            className="mt-3 w-full rounded-xl bg-orange-500 px-4 py-3 text-base font-semibold text-white transition hover:bg-orange-400"
          >
            Create Child Note
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={() => {
          if (typeof window === 'undefined') return;
          clearMergePair();
          closeContextMenu();
          const screenPoint = {
            x: window.innerWidth / 2,
            y: window.innerHeight / 2,
          };
          createNoteFromScreenPoint(screenPoint, { text: '' });
        }}
        className="absolute bottom-10 right-10 z-50 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-4xl font-bold text-white shadow-[0_25px_60px_rgba(16,185,129,0.45)] transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-4 focus-visible:ring-white/60"
        aria-label="Create a new sticky note"
      >
        +
      </button>
      <ReactFlow
        className="h-full w-full"
        nodeTypes={nodeTypes}
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneDoubleClick={handlePaneDoubleClick}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        defaultViewport={{ x: 0, y: 0, zoom: 0.9 }}
        minZoom={0.3}
        maxZoom={1.5}
        panOnScroll
        panOnDrag
        zoomOnDoubleClick={false}
        fitView={false}
        defaultEdgeOptions={defaultEdgeOptions}
      >
        <Background color="#1e293b" gap={28} size={1.5} variant="dots" />
        <Controls className="rounded-full bg-slate-900/80 text-white" position="top-left" />
      </ReactFlow>
    </div>
  );
};

const CanvasShell = () => {
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const stored = await db.canvasState.get('latest');
        if (stored && !cancelled) {
          useCanvasStore.getState().replaceState({
            nodes: stored.nodes ?? [],
            edges: stored.edges ?? [],
          });
        }
      } catch (error) {
        console.error('Failed to load Synapse state', error);
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    };
    load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const debouncedSave = debounce(async ({ nodes, edges }) => {
      try {
        await db.canvasState.put({
          id: 'latest',
          nodes: nodes.map(sanitizeNodeForSave),
          edges,
          savedAt: Date.now(),
        });
      } catch (error) {
        console.error('Failed to persist Synapse state', error);
      }
    }, 500);

    const unsubscribe = useCanvasStore.subscribe(
      (state) => ({ nodes: state.nodes, edges: state.edges }),
      (snapshot) => debouncedSave(snapshot),
    );

    return () => {
      unsubscribe();
      debouncedSave.cancel?.();
    };
  }, []);

  if (!isReady) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-950 text-slate-200">
        <div className="rounded-3xl bg-slate-900/70 px-8 py-6 text-center text-xl">
          Loading your Synapse wall…
        </div>
      </div>
    );
  }

  return <CanvasExperience />;
};

const App = () => (
  <ReactFlowProvider>
    <div className="h-screen w-screen overflow-hidden bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900">
      <CanvasShell />
    </div>
  </ReactFlowProvider>
);

export default App;

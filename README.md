# Synapse — VR-First Infinite Note Wall

Synapse is a browser-based, VR-friendly infinite canvas built with React Flow. Sticky notes live completely in the browser with IndexedDB persistence, so ideas stay local while you pan, zoom, branch, and merge without leaving the headset.

## Stack

- Vite + React 19
- React Flow for the canvas
- Zustand for global state
- Dexie.js for IndexedDB persistence
- Tailwind CSS for VR-friendly styling

## Getting Started

```bash
npm install
npm run dev
```

The dev server runs on [http://localhost:5173](http://localhost:5173). Build with `npm run build` when you are ready to ship.

## Core Interactions

- Double-tap empty canvas space to create a sticky note at that position.
- Drag notes to reposition; they float to the front when touched.
- Hold a note to open the context menu and spawn linked child notes.
- Drop one note onto another to flag a merge, then tap either note to confirm.
- Use the settings button (top-right) to export or import a `synapse-project.json` snapshot.

## Data & Persistence

All state lives in IndexedDB (`SynapseDB`). Changes auto-save with debounce, and the most recent canvas restores on load. Exported files can be imported later or shared manually.

## Future AI Hook

The settings panel includes a disabled Ollama endpoint field (`http://100.113.82.99:11434`), leaving a clear surface for the upcoming v2 smart merge/branching work.

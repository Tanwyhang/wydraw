import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, CaptureUpdateAction } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import "./style.css";

async function request(route, body) {
  const response = await fetch(`/api/${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${window.DIAGRAM_TOKEN}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error);
  return result;
}

function App() {
  const [doc, setDoc] = useState(null),
    [mode, setMode] = useState("view");
  const [message, setMessage] = useState("Loading"),
    [busy, setBusy] = useState(false);
  const [untangled, setUntangled] = useState(false);
  const api = useRef(null),
    current = useRef(null),
    pending = useRef(null),
    timer = useRef(null),
    saving = useRef(null);
  async function refresh() {
    const next = await request("scene");
    if (current.current?.revision !== next.revision) {
      current.current = next;
      api.current?.updateScene({
        elements: next.scene.elements,
        appState: next.scene.appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (next.scene.files)
        api.current?.addFiles(Object.values(next.scene.files));
      setDoc(next);
    }
    setUntangled(!!next.scene.wydraw?.untangle);
    setMode(next.mode);
    setMessage(
      next.mode === "cursor"
        ? "Cursor mode · agent writes paused"
        : "View mode · agent ready",
    );
  }
  async function flush() {
    if (saving.current) await saving.current;
    while (pending.current) {
      const scene = pending.current;
      pending.current = null;
      saving.current = request("save", {
        revision: current.current.revision,
        scene,
      });
      try {
        current.current = await saving.current;
        if (current.current.scene.wydraw?.untangle)
          api.current?.updateScene({
            elements: current.current.scene.elements,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        setMessage("Saved locally");
      } catch (error) {
        pending.current = scene;
        throw error;
      } finally {
        saving.current = null;
      }
    }
  }
  useEffect(() => {
    refresh().catch((e) => setMessage(e.message));
    return () => clearTimeout(timer.current);
  }, []);
  useEffect(() => {
    if (mode === "cursor") return;
    const events = new EventSource(`/api/events?token=${window.DIAGRAM_TOKEN}`);
    events.onmessage = () => refresh().catch((e) => setMessage(e.message));
    return () => events.close();
  }, [mode]);
  useEffect(() => {
    const beforeUnload = (e) => {
      if (mode === "cursor") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [mode]);
  async function toggle() {
    setBusy(true);
    clearTimeout(timer.current);
    try {
      if (mode === "cursor") await flush();
      await request("mode", { mode: mode === "cursor" ? "view" : "cursor" });
      await refresh();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleUntangle(enabled) {
    setUntangled(enabled);
    setBusy(true);
    clearTimeout(timer.current);
    try {
      if (mode === "cursor") await flush();
      await request("untangle", {
        revision: current.current.revision,
        enabled,
      });
      await refresh();
    } catch (error) {
      setUntangled(!!current.current?.scene.wydraw?.untangle);
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }
  function changed(elements, appState, files) {
    if (mode !== "cursor" || busy || !current.current) return;
    if (
      JSON.stringify(elements.filter((e) => !e.isDeleted)) ===
        JSON.stringify(current.current.scene.elements) &&
      appState.viewBackgroundColor ===
        current.current.scene.appState.viewBackgroundColor &&
      JSON.stringify(files) === JSON.stringify(current.current.scene.files)
    )
      return;
    pending.current = {
      ...current.current.scene,
      elements: elements.filter((e) => !e.isDeleted),
      files,
      appState: {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
      },
    };
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => flush().catch((e) => setMessage(e.message)),
      350,
    );
  }
  return (
    <main data-mode={mode}>
      <label className="untangle-toggle" title="Untangle connected arrows">
        <input
          type="checkbox"
          aria-label="Untangle connected arrows"
          checked={untangled}
          disabled={!doc || busy}
          onChange={(e) => toggleUntangle(e.target.checked)}
        />
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M3 5h6v14h12M3 19h3V5h15" />
        </svg>
      </label>
      <button
        className="mode-toggle"
        aria-label={
          mode === "cursor" ? "Save · return to agent" : "Enable cursor mode"
        }
        disabled={!doc || busy}
        onClick={toggle}
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {mode === "cursor" ? (
            <path d="m5 12 4 4L19 6" />
          ) : (
            <>
              <path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14Z" />
              <path d="m4 14 5 5" />
            </>
          )}
        </svg>
      </button>
      <section>
        {doc && (
          <Excalidraw
            initialData={{
              ...doc.scene,
              appState: {
                ...doc.scene.appState,
                currentItemFontFamily: 3,
                currentItemRoughness: 1,
                currentItemRoundness: "round",
                currentItemStrokeColor: "#373b3b",
              },
              scrollToContent: true,
            }}
            excalidrawAPI={(value) => {
              api.current = value;
            }}
            viewModeEnabled={mode !== "cursor" || busy}
            onChange={changed}
            theme="light"
            UIOptions={{
              canvasActions: {
                loadScene: false,
                saveAsImage: true,
                export: { saveFileToDisk: true },
              },
            }}
          />
        )}
      </section>
      <footer className="sr-only" role="status">
        {message}
      </footer>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);

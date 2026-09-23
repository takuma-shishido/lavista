import { render } from "ink";
import type { Reporter } from "../events.js";
import type { RunStore } from "../store.js";
import { App } from "./App.js";
import { Feed, initialView } from "./view.js";

/** Full-screen view of both agents. The alternate screen is restored on exit, so a summary is printed then. */
export function tuiReporter(store: RunStore, onStop: () => void): Reporter {
  const state = store.load();
  const describe = (model: string, effort: string) =>
    [model || "CLI default model", effort && `effort ${effort}`].filter(Boolean).join(" · ");
  const feed = new Feed(initialView(store.id, store.directory, {
    claude: describe(state.claude_model, state.claude_effort),
    astra: describe(state.astra_model, state.astra_effort),
  }));
  const stop = () => {
    feed.update((view) => ({ ...view, status: "stopping" }));
    onStop();
  };
  const instance = render(<App feed={feed} onStop={stop} />, { alternateScreen: true, exitOnCtrlC: false });

  return {
    emit: (event) => feed.dispatch(event),
    async close() {
      feed.update((view) => ({ ...view, status: "stopped" }));
      instance.unmount();
      await instance.waitUntilExit();
      const view = feed.getSnapshot();
      for (const { iteration, review } of view.decisions) {
        console.log(`#${iteration} ${review.decision}: ${review.reason}`);
      }
      if (view.notice) console.log(view.notice);
      console.log(`logs: ${view.runDirectory}`);
    },
  };
}

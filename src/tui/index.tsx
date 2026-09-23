import { render } from "ink";
import type { Reporter } from "../events.js";
import type { RunStore } from "../store.js";
import { App } from "./App.js";
import { Feed, initialView } from "./view.js";

/** Full-screen view of both agents. The alternate screen is restored on exit, so a summary is printed then. */
export function tuiReporter(store: RunStore, onStop: () => void): Reporter {
  const { claude_model, astra_model } = store.load();
  const feed = new Feed(initialView(store.id, store.directory, { claude: claude_model, astra: astra_model }));
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

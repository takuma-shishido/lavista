import { render } from "ink";
import type { PermissionAnswer, PermissionRequest, Reporter } from "../events.js";
import { formatPlan } from "../model.js";
import { notify } from "../notify.js";
import type { RunStore } from "../store.js";
import { App } from "./App.js";
import { Feed, initialView } from "./view.js";

interface Question {
  request: PermissionRequest;
  answer(answer: PermissionAnswer): void;
}

/**
 * Full-screen view of both agents. The alternate screen is restored on exit, so a summary is printed then.
 * The first stop key asks the agents to stop; the next one forces it.
 * Permission requests are shown one at a time, oldest first, until answered.
 * Text the user writes goes to Claude through `send`, which is false when no Claude step is running.
 */
export function tuiReporter(store: RunStore, onStop: () => void, onForce: () => void, send: (text: string) => boolean): Reporter {
  const state = store.load();
  const describe = (model: string, effort: string) =>
    [model || "CLI default model", effort && `effort ${effort}`].filter(Boolean).join(" · ");
  const feed = new Feed(initialView(store.id, store.directory, {
    claude: describe(state.claude_model, state.claude_effort),
    astra: describe(state.astra_model, state.astra_effort),
  }, state.plan));
  const questions: Question[] = [];
  const showQuestion = () => feed.update(({ question: _shown, ...view }) => {
    const next = questions[0];
    return next ? { ...view, question: next.request } : view;
  });
  const answer = (value: PermissionAnswer) => questions[0]?.answer(value);
  // A delivered message shows up in Claude's pane once it is logged with Claude's events.
  const message = (text: string) => {
    if (!send(text)) feed.update((view) => ({ ...view, notice: "Not sent: Claude is not working on a step right now." }));
  };
  const stop = () => {
    if (feed.getSnapshot().status !== "running") return onForce();
    feed.update((view) => ({ ...view, status: "stopping" }));
    onStop();
  };
  const instance = render(<App feed={feed} onStop={stop} onAnswer={answer} onSend={message} />, { alternateScreen: true, exitOnCtrlC: false });

  return {
    emit: (event) => feed.dispatch(event),
    ask: (request, signal) => new Promise((resolve) => {
      if (signal.aborted) return resolve("deny");
      const question: Question = {
        request,
        answer(value) {
          signal.removeEventListener("abort", cancel);
          questions.splice(questions.indexOf(question), 1);
          showQuestion();
          resolve(value);
        },
      };
      const cancel = () => question.answer("deny");
      signal.addEventListener("abort", cancel, { once: true });
      questions.push(question);
      if (questions.length === 1) {
        showQuestion();
        notify(`Claude asks to use ${request.tool}: ${request.detail}`);
      }
    }),
    async close() {
      feed.update((view) => ({ ...view, status: "stopped" }));
      instance.unmount();
      await instance.waitUntilExit();
      const view = feed.getSnapshot();
      for (const { iteration, review } of view.decisions) {
        console.log(`#${iteration} ${review.decision}: ${review.reason}`);
      }
      if (view.plan.length > 0) console.log(formatPlan(view.plan));
      if (view.notice) console.log(view.notice);
      console.log(`logs: ${view.runDirectory}`);
    },
  };
}

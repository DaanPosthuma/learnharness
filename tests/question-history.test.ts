import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectQuestionHistory, stepHistory } from "../components/question-history.ts";
import type { LhViewMessage } from "../src/core/view.ts";

/** Fork (2026-11-22): the dock's question-history pager. On a phone the next
 * question opens over the previous answer's feedback, so the learner pages
 * back through answered questions + the teacher's reply in the dock. */

const answered = (id: string, type = "tool-quiz") => ({ type, toolCallId: id, state: "output-available", input: { question: `Q ${id}` }, output: { kind: "quiz", id } });
const pending = (id: string) => ({ type: "tool-quiz", toolCallId: id, state: "input-available", input: { question: `Q ${id}` } });
const text = (t: string) => ({ type: "text", text: t });

describe("collectQuestionHistory", () => {
	it("one step per answered question, with the teacher's text that followed it", () => {
		const messages: LhViewMessage[] = [
			{ id: "a1", role: "assistant", parts: [text("Intro."), answered("q1"), text("Right — because X."), { type: "step-start" }, text("More on X."), answered("q2", "tool-probe"), text("Not quite.")] },
			{ id: "a2", role: "assistant", parts: [text("Also Y."), pending("q3")] },
		];
		const steps = collectQuestionHistory(messages);
		assert.deepEqual(steps.map(s => [s.toolCallId, s.type, s.after]), [
			["q1", "tool-quiz", ["Right — because X.", "More on X."]],
			["q2", "tool-probe", ["Not quite.", "Also Y."]],
		]);
		assert.deepEqual(steps[0]?.output,{ kind: "quiz", id: "q1" }, "the saved answer rides along for the AnsweredCard");
	});

	it("a learner message ends the reply; the pending question and blank text are not history", () => {
		const messages: LhViewMessage[] = [
			{ id: "a1", role: "assistant", parts: [answered("q1"), text("  "), text("Good.")] },
			{ id: "u1", role: "user", parts: [text("Why though?")] },
			{ id: "a2", role: "assistant", parts: [text("Because Z."), pending("q2")] },
		];
		assert.deepEqual(collectQuestionHistory(messages).map(s => [s.toolCallId, s.after]), [["q1", ["Good."]]]);
	});

	it("ignores other tools and answers still streaming", () => {
		const messages: LhViewMessage[] = [
			{ id: "a1", role: "assistant", parts: [{ type: "tool-plan_init", toolCallId: "p", state: "output-available", output: {} }, { type: "tool-quiz", toolCallId: "q", state: "input-streaming" }] },
		];
		assert.deepEqual(collectQuestionHistory(messages), []);
	});
});

describe("stepHistory", () => {
	it("back from the live question lands on the newest answer; forward past the newest returns to live", () => {
		assert.equal(stepHistory(null, -1, 3), 2);
		assert.equal(stepHistory(2, -1, 3), 1);
		assert.equal(stepHistory(0, -1, 3), 0, "clamped at the first question");
		assert.equal(stepHistory(1, 1, 3), 2);
		assert.equal(stepHistory(2, 1, 3), null);
		assert.equal(stepHistory(null, 1, 3), null);
		assert.equal(stepHistory(null, -1, 0), null, "nothing answered yet");
	});
});

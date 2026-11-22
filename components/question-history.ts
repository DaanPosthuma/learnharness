/* Question history (fork, 2026-11-22): on a phone the next question opens
 * over the previous answer's feedback the moment it arrives, so the
 * explanation is only on screen for a moment. The dock offers a pager back
 * through the answered questions instead; this module is its pure source:
 * the transcript → one step per answered built-in question, carrying the
 * teacher's text that followed the answer (up to the next question or the
 * learner's next message). */
import type { LhViewMessage, LhViewPart } from "@/src/core";

/** The built-in question tools whose answered form is an AnsweredCard. */
export const HISTORY_QUESTION_TOOLS: ReadonlySet<string> = new Set([
	"tool-quiz",
	"tool-probe",
	"tool-ask_user_question",
	"tool-explain",
	"tool-recall",
]);

export interface QuestionHistoryStep {
	toolCallId: string;
	/** The view part type, e.g. "tool-quiz". */
	type: string;
	input: unknown;
	/** The saved answer (QuestionAnswerData), as the AnsweredCard reads it. */
	output: unknown;
	/** The teacher's text after the answer, in order, empty parts dropped. */
	after: string[];
}

function isQuestionPart(part: LhViewPart): boolean {
	return HISTORY_QUESTION_TOOLS.has(part.type);
}

export function collectQuestionHistory(messages: readonly LhViewMessage[]): QuestionHistoryStep[] {
	const steps: QuestionHistoryStep[] = [];
	let open: QuestionHistoryStep | null = null;
	for (const message of messages) {
		if (message.role === "user") {
			// The learner spoke: what follows answers them, not the question.
			open = null;
			continue;
		}
		for (const part of message.parts) {
			if (isQuestionPart(part)) {
				open = null;
				if (part.state === "output-available" && part.toolCallId && part.output !== undefined) {
					open = { toolCallId: part.toolCallId, type: part.type, input: part.input, output: part.output, after: [] };
					steps.push(open);
				}
				continue;
			}
			if (open && part.type === "text" && typeof part.text === "string" && part.text.trim()) open.after.push(part.text);
		}
	}
	return steps;
}

/** The pager's next index: null is "the current question". Going back from
 *  the current question lands on the newest answered step. */
export function stepHistory(index: number | null, delta: -1 | 1, length: number): number | null {
	if (length === 0) return null;
	if (index === null) return delta < 0 ? length - 1 : null;
	const next = index + delta;
	if (next < 0) return 0;
	if (next >= length) return null;
	return next;
}

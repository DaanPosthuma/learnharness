"use client";

/* Question history in the dock (fork, 2026-11-22) — see
 * components/question-history.ts for the why. Two pieces:
 *   - QuestionHistoryEntry: the slim "‹ Previous question" row above an open
 *     question, shown only when something was answered before;
 *   - QuestionHistoryReview: one answered step (its card with the
 *     explanation open, then the teacher's reply), with ‹ › to page and a
 *     way back to the current question.
 * The dock keeps the live question MOUNTED (hidden) while reviewing, so a
 * half-made answer survives the detour. */
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { AnsweredCard } from "@/components/answered-card";
import { MessageResponse } from "@/components/ai-elements/message";
import { stepHistory, type QuestionHistoryStep } from "@/components/question-history";
import type { QuestionAnswerData } from "@/src/core";

const PAGER_BUTTON =
	"inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40";

export function QuestionHistoryEntry({ count, onOpen }: { count: number; onOpen: () => void }) {
	if (count === 0) return null;
	return (
		<div className="flex px-3 pt-2" data-testid="question-history-entry">
			<button type="button" className={PAGER_BUTTON} onClick={onOpen} aria-label="Review the previous question and its explanation">
				<ChevronLeftIcon className="size-3.5" aria-hidden />
				Previous question
			</button>
		</div>
	);
}

export function QuestionHistoryReview({
	steps,
	index,
	onIndex,
	height,
}: {
	steps: readonly QuestionHistoryStep[];
	index: number;
	/** null returns to the current question. */
	onIndex: (index: number | null) => void;
	/** The open question's height: the review keeps it so the dock never
	 *  resizes (no transcript shift, no fold-machine reaction). null = natural. */
	height?: number | null;
}) {
	const step = steps[index];
	if (!step) return null;
	return (
		<div data-testid="question-history-review" className="flex min-h-0 flex-col" style={height ? { height } : undefined}>
			<div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
				<button type="button" className={PAGER_BUTTON} disabled={index === 0} onClick={() => onIndex(stepHistory(index, -1, steps.length))} aria-label="Earlier question">
					<ChevronLeftIcon className="size-3.5" aria-hidden />
				</button>
				<span className="font-ui text-xs tabular-nums text-muted-foreground" data-testid="question-history-position">
					Question {index + 1} of {steps.length}
				</span>
				<button type="button" className={PAGER_BUTTON} onClick={() => onIndex(stepHistory(index, 1, steps.length))} aria-label={index === steps.length - 1 ? "Back to the current question" : "Later question"}>
					<ChevronRightIcon className="size-3.5" aria-hidden />
				</button>
				<button type="button" className={`${PAGER_BUTTON} ml-auto text-foreground`} onClick={() => onIndex(null)} data-testid="question-history-back">
					Current question
					<ChevronRightIcon className="size-3.5" aria-hidden />
				</button>
			</div>
			{/* Own scroll: on a phone the step can outgrow the dock band. */}
			<div className={`${height ? "min-h-0 flex-1" : "max-h-[min(60dvh,32rem)]"} overflow-y-auto overscroll-contain px-4 py-3`}>
				<AnsweredCard key={step.toolCallId} answer={step.output as QuestionAnswerData} input={step.input} toolCallId={step.toolCallId} whyInitiallyOpen />
				{step.after.map((text, i) => (
					<div key={i} className="mt-3">
						<MessageResponse>{text}</MessageResponse>
					</div>
				))}
			</div>
		</div>
	);
}

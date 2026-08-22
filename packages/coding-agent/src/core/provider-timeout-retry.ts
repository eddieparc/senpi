import type { AgentContinuationOptions } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { isProviderTimeoutError } from "@earendil-works/pi-ai/compat";

export interface ProviderTimeoutRetryPlan {
	options: AgentContinuationOptions;
	watchdogTimeoutMs: number | undefined;
}

export interface ProviderTimeoutRetryPlanInput {
	message: AssistantMessage;
	streamRetryTimeoutMs: number | undefined;
	timeoutMs: number | undefined;
	streamStartTimeoutMs: number | undefined;
}

/**
 * Raise the retry-continuation liveness cap to the stream-start budget granted to
 * the same retry, so the watchdog can never cancel an attempt on a deadline the
 * attempt was never given.
 *
 * An explicitly disabled cap (`undefined`) stays disabled: the operator opted out
 * of the wedge guard, and the provider guards still bound the request. A cap that
 * already outlasts the granted guard is returned unchanged, so an operator who
 * configured a longer cap keeps it.
 */
function reconcileWatchdogTimeoutMs(
	streamRetryTimeoutMs: number | undefined,
	streamStartTimeoutMs: number | undefined,
): number | undefined {
	if (streamRetryTimeoutMs === undefined) return undefined;
	if (streamStartTimeoutMs === undefined) return streamRetryTimeoutMs;
	return Math.max(streamRetryTimeoutMs, streamStartTimeoutMs);
}

export interface BoundedRetryContinuation {
	continueRun(): Promise<void>;
	getActiveSignal(): AbortSignal | undefined;
	abortActive(): void;
	timeoutMs: number | undefined;
}

export function createProviderTimeoutRetryPlan({
	message,
	streamRetryTimeoutMs,
	timeoutMs,
	streamStartTimeoutMs,
}: ProviderTimeoutRetryPlanInput): ProviderTimeoutRetryPlan {
	if (!isProviderTimeoutError(message)) {
		return { options: {}, watchdogTimeoutMs: undefined };
	}

	// The retry keeps the user's configured provider guards: shortening them
	// made a 90s stream-start budget expire after 30s, so a slow-but-alive
	// provider was reported as a second stall instead of being given the budget
	// it was configured with. `streamRetryTimeoutMs` still bounds the retry
	// continuation itself (see `runBoundedRetryContinuation`), which cancels a
	// wedged retry without lying to the provider about its deadline.
	//
	// The cap is reconciled against the guards this same retry was granted. A cap
	// shorter than the stream-start budget re-created the very defect the guards
	// were kept for, one layer up: the continuation was aborted at 30s while the
	// request still had 60s of its configured 90s budget left, so no attempt could
	// ever finish and the bounded `retry.maxRetries` budget collapsed into the
	// single "Aborted after 1 retry attempt" outcome. Raising the watchdog to the
	// granted guard keeps the wedge protection (the guards themselves still fail a
	// dead upstream, and the watchdog still cancels a retry that outlives them)
	// while letting a slow-but-alive provider spend the budget it was configured
	// with across the full retry budget.
	return {
		options: {
			deferQueuedMessages: true,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(streamStartTimeoutMs === undefined ? {} : { streamStartTimeoutMs }),
		},
		watchdogTimeoutMs: reconcileWatchdogTimeoutMs(streamRetryTimeoutMs, streamStartTimeoutMs),
	};
}

export async function runBoundedRetryContinuation({
	continueRun,
	getActiveSignal,
	abortActive,
	timeoutMs,
}: BoundedRetryContinuation): Promise<void> {
	const continuation = continueRun();
	const ownedSignal = getActiveSignal();
	if (timeoutMs === undefined || ownedSignal === undefined) {
		await continuation;
		return;
	}

	const timer = setTimeout(() => {
		if (getActiveSignal() === ownedSignal) {
			abortActive();
		}
	}, timeoutMs);
	try {
		await continuation;
	} finally {
		clearTimeout(timer);
	}
}

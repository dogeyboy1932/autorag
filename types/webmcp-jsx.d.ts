/**
 * JSX typings for the declarative WebMCP attributes.
 *
 * These are real HTML attributes the browser reads to derive a tool from a
 * <form>, but they are not in React's DOM typings, so TSX rejects them without
 * this augmentation. Names are lowercase because that is how they must appear
 * in the emitted HTML — React passes unknown lowercase props through verbatim.
 */
import 'react';

declare module 'react' {
  interface FormHTMLAttributes<T> {
    /** Tool name derived from this form, e.g. "autorag_submit_passage_form". */
    toolname?: string;
    /** What the derived tool does, written for an agent. */
    tooldescription?: string;
    /**
     * Submit the form as soon as an agent has filled it, instead of focusing the
     * submit button and waiting for a person to click.
     *
     * **Must be written `toolautosubmit=""`.** React drops an unknown attribute
     * whose value is the boolean `true`, so the JSX shorthand never reaches the
     * DOM — typed as `''` here so the compiler enforces that.
     */
    toolautosubmit?: '';
  }
  interface InputHTMLAttributes<T> {
    /** Per-field description for the derived tool's input schema. */
    toolparamdescription?: string;
  }
  interface TextareaHTMLAttributes<T> {
    toolparamdescription?: string;
  }
  interface SelectHTMLAttributes<T> {
    toolparamdescription?: string;
  }
}

/**
 * `SubmitEvent` as the declarative API actually extends it. Neither field is in
 * lib.dom yet: `agentInvoked` distinguishes an agent's submission from a
 * person's, and `respondWith` is the only way to hand a result back to the
 * agent — without it the call resolves with nothing.
 *
 * Both must be touched synchronously, during dispatch.
 */
declare global {
  interface SubmitEvent {
    readonly agentInvoked?: boolean;
    respondWith?(result: Promise<unknown> | unknown): void;
  }
}

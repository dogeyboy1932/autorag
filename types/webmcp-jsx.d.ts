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

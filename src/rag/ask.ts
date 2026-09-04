/**
 * What the answering half needs to know about models, shared by both surfaces.
 *
 * These four symbols used to live in `extension/src/protocol.ts`, which was the
 * right home while the extension was the only thing that could answer a question.
 * The web app can now too, and a web page has no business importing the
 * extension's message vocabulary to find out what Opus costs. `protocol.ts`
 * re-exports them, so the extension still has one file describing everything it
 * speaks.
 */

/** Where the answering model lives and what it costs. */
export interface AskSettings {
  /**
   * The person's own Anthropic key. Empty means they have not supplied one.
   *
   * With a key, the call goes straight to `api.anthropic.com` and streams. Without
   * one, `proxyEndpoint` decides whether there is any other way to answer.
   */
  apiKey: string;
  model: string;
  /**
   * A server that holds somebody else's key, used only when `apiKey` is empty.
   *
   * This is how the deployed web app answers for a visitor who has not signed up
   * for anything: `netlify/functions/ask.ts` holds the author's key, caps each
   * visitor at ten answers and never hands the key to a browser. The extension
   * never sets this — an extension can hold a key of its own, so there is nothing
   * for a proxy to solve there, and pointing it at one would put the author's
   * budget behind every install.
   */
  proxyEndpoint?: string;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The models on offer, with what they cost, because Ask is the first thing in
 * Autorag that spends money and a price nobody can see is a price nobody agreed to.
 */
export const ASK_MODELS = [
  /*
   * `adaptive` marks the models that take `thinking: {type:'adaptive'}` and
   * `output_config.effort`. Haiku 4.5 predates both: adaptive thinking is not a
   * mode it has, and `effort` is rejected outright. Sending them anyway made every
   * Haiku answer fail — a picker that offers a model and then speaks to it in a
   * dialect it does not understand.
   */
  { id: 'claude-opus-5', label: 'Opus 5', input: 5, output: 25, adaptive: true },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', input: 2, output: 10, adaptive: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', input: 1, output: 5, adaptive: false },
] as const;

export const DEFAULT_ASK_MODEL = 'claude-opus-5';

/** The model label for a stored id, falling back rather than rendering a blank. */
export const modelLabel = (id: string) =>
  ASK_MODELS.find((m) => m.id === id)?.label ?? ASK_MODELS[0].label;

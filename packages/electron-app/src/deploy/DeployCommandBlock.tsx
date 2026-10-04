import React from 'react';

/**
 * A shell command the way a recipe needs it: a block, with its own copy button.
 *
 * The recipe panes used to drop commands inline — `<br /><code>{cmd}</code>` inside a wrapping
 * paragraph — which works for a one-word directive and falls apart for the fetch-and-report
 * one-liners these panes actually print: the inline box fragments across wrapped lines, so a
 * four-line `curl … && mv … && unbound-checkconf` reads as choppy blue pieces with no way to tell
 * where the command ends. A block element cannot fragment, so the command stays one object, and
 * the `pre-wrap` inside it breaks at the same places a terminal would paste them.
 *
 * The button is per-block rather than one "copy the command" button per card because a recipe
 * lists the same command per platform — a single button makes the user scroll back up and guess
 * which variant it copies. Each block takes its own `copyKey`, so the "Copied" flash lands on
 * the command the user actually took.
 *
 * Presentational only: copying is the Hub's `handleCopy`, passed through like everything else a
 * pane renders, so this stays renderable from an object literal in a test.
 */
export interface DeployCommandBlockProps {
  /** The command text, rendered verbatim. */
  command: string;
  /** The copy-feedback key this block lights up under. */
  copyKey: string;
  /** The key currently showing "Copied", or null when none is — the Hub's `copiedKey`. */
  copiedKey: string | null;
  /** The Hub's copy handler, so a pane passes the same function its buttons use. */
  onCopy: (text: string, key: string) => void;
}

export const DeployCommandBlock: React.FC<DeployCommandBlockProps> = ({
  command,
  copyKey,
  copiedKey,
  onCopy,
}) => (
  <div className="deploy-command-block">
    <pre className="deploy-command-text">{command}</pre>
    <button
      type="button"
      className={`deploy-command-copy ${copiedKey === copyKey ? 'copied' : ''}`}
      onClick={() => onCopy(command, copyKey)}
    >
      {copiedKey === copyKey ? '✓ Copied' : 'Copy'}
    </button>
  </div>
);

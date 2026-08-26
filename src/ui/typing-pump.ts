import { displayWidth } from "./display-width.js";
import {
  ReasoningViewport,
  type ReasoningViewportOptions,
  type ViewportUnit,
} from "./reasoning-viewport.js";

const TICK_MS = 20;
const MIN_RATE = 300;
const MAX_RATE = 12_000;
const DEFAULT_RATE = 500;
const RATE_WINDOW_MS = 1_000;

const ANSI_SEQUENCE = new RegExp(`^${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "u");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface TypedUnit extends ViewportUnit {
  visible: boolean;
}

interface ViewportItem {
  type: "viewport";
  units: TypedUnit[];
  offset: number;
  open: boolean;
  viewport: ReasoningViewport;
}

type OutputItem =
  | { type: "typed"; units: TypedUnit[]; offset: number }
  | { type: "instant"; text: string }
  | ViewportItem;

export interface TypingPumpOptions {
  write: (text: string) => void;
  interactive: () => boolean;
  now?: () => number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function graphemes(text: string): string[] {
  return [...graphemeSegmenter.segment(text)].map((part) => part.segment);
}

function visibleLength(text: string): number {
  let length = 0;
  let rest = text;
  while (rest !== "") {
    const ansi = rest.match(ANSI_SEQUENCE)?.[0];
    if (ansi !== undefined) {
      rest = rest.slice(ansi.length);
      continue;
    }

    const escape = rest.indexOf("\x1b");
    const plain = escape === -1 ? rest : rest.slice(0, escape);
    length += graphemes(plain).length;
    rest = escape === -1 ? "" : rest.slice(escape);
    if (plain === "" && rest.startsWith("\x1b")) {
      // Unknown escape sequence: keep the ESC as an ordinary atomic unit.
      length += 1;
      rest = rest.slice(1);
    }
  }
  return length;
}

function typedUnits(text: string): TypedUnit[] {
  const units: TypedUnit[] = [];
  let rest = text;
  while (rest !== "") {
    const ansi = rest.match(ANSI_SEQUENCE)?.[0];
    if (ansi !== undefined) {
      units.push({ text: ansi, visible: false, width: 0, lineBreak: false });
      rest = rest.slice(ansi.length);
      continue;
    }

    const escape = rest.indexOf("\x1b");
    const plain = escape === -1 ? rest : rest.slice(0, escape);
    units.push(
      ...graphemes(plain).map((unit) => ({
        text: unit,
        visible: true,
        width: unit === "\n" ? 0 : displayWidth(unit),
        lineBreak: unit === "\n",
      })),
    );
    rest = escape === -1 ? "" : rest.slice(escape);
    if (plain === "" && rest.startsWith("\x1b")) {
      units.push({ text: "\x1b", visible: true, width: 0, lineBreak: false });
      rest = rest.slice(1);
    }
  }
  return units;
}

/**
 * Serializes gradual transcript output and the single mutable tool-status line.
 * It is the only component allowed to write cursor-control sequences while a
 * turn is active, so typed text and the spinner can never race each other.
 */
export class TypingPump {
  readonly #write: (text: string) => void;
  readonly #interactive: () => boolean;
  readonly #now: () => number;
  #queue: OutputItem[] = [];
  #openViewport: ViewportItem | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #rate = DEFAULT_RATE;
  #windowChars = 0;
  #windowStartedAt: number | undefined;
  #lastObservedAt: number | undefined;
  #idleWaiters: (() => void)[] = [];
  #liveMode = false;
  #liveModePending = false;
  #liveLineVisible = false;
  #cursorHidden = false;
  #cursorHolds = 0;
  #generation = 0;

  constructor(options: TypingPumpOptions) {
    this.#write = options.write;
    this.#interactive = options.interactive;
    this.#now = options.now ?? Date.now;
  }

  resetRate(): void {
    this.#rate = DEFAULT_RATE;
    this.#windowChars = 0;
    this.#windowStartedAt = undefined;
    this.#lastObservedAt = undefined;
  }

  /** Keeps the cursor hidden while a streaming renderer buffers its first line. */
  holdCursor(): void {
    if (!this.#interactive()) return;
    this.#cursorHolds += 1;
    this.#hideCursor();
  }

  releaseCursor(): void {
    if (!this.#interactive() || this.#cursorHolds === 0) return;
    this.#cursorHolds -= 1;
    this.#showCursorIfIdle();
  }

  /** Records source stream throughput without counting rendered ANSI codes. */
  observeIncoming(text: string): void {
    if (text === "") return;
    const now = this.#now();
    if (this.#lastObservedAt !== undefined && now - this.#lastObservedAt > RATE_WINDOW_MS) {
      this.#windowChars = 0;
      this.#windowStartedAt = now;
    }
    this.#windowStartedAt ??= now;
    this.#lastObservedAt = now;
    this.#windowChars += visibleLength(text);

    const elapsed = now - this.#windowStartedAt;
    if (elapsed >= RATE_WINDOW_MS) {
      const measured = clamp((this.#windowChars / elapsed) * 1_000, MIN_RATE, MAX_RATE);
      this.#rate = (this.#rate + measured) / 2;
      this.#windowChars = 0;
      this.#windowStartedAt = now;
    }
  }

  push(text: string): void {
    if (text === "") return;
    if (!this.#interactive()) {
      this.#write(text);
      return;
    }

    const units = typedUnits(text);
    if (units.length === 0) return;
    this.#queue.push({ type: "typed", units, offset: 0 });
    this.#hideCursor();
    if (!this.#liveMode && !this.#liveModePending) this.#ensureTimer();
  }

  /** Preserves queue order but writes the item atomically when it reaches the head. */
  pushInstant(text: string): void {
    if (text === "") return;
    if (
      !this.#interactive() ||
      (!this.#liveMode &&
        !this.#liveModePending &&
        this.#queue.length === 0 &&
        this.#timer === undefined)
    ) {
      this.#write(text);
      return;
    }

    this.#queue.push({ type: "instant", text });
    if (!this.#liveMode && !this.#liveModePending) this.#ensureTimer();
  }

  beginViewport(options: ReasoningViewportOptions): void {
    if (this.#openViewport) throw new Error("Reasoning viewport is already open");
    const item: ViewportItem = {
      type: "viewport",
      units: [],
      offset: 0,
      open: true,
      viewport: new ReasoningViewport(options),
    };
    this.#openViewport = item;
    this.#queue.push(item);
    this.#hideCursor();
    if (!this.#liveMode && !this.#liveModePending) this.#ensureTimer();
  }

  pushViewport(text: string): void {
    if (text === "") return;
    const viewport = this.#openViewport;
    if (!viewport) throw new Error("Reasoning viewport is not open");
    viewport.units.push(...typedUnits(text));
    if (!this.#liveMode && !this.#liveModePending) this.#ensureTimer();
  }

  closeViewport(): void {
    const viewport = this.#openViewport;
    if (!viewport) return;
    viewport.open = false;
    this.#openViewport = undefined;
    if (!this.#liveMode && !this.#liveModePending) this.#ensureTimer();
  }

  whenIdle(): Promise<void> {
    if (this.#queue.length === 0 && this.#timer === undefined) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Waits for transcript output, then gives exclusive ownership to a live status line. */
  async enterLiveMode(): Promise<void> {
    if (this.#liveMode) return;
    const generation = this.#generation;
    this.#liveModePending = true;
    await this.whenIdle();
    if (generation !== this.#generation) return;
    this.#liveModePending = false;
    this.#liveMode = true;
    this.#hideCursor();
  }

  /** Writes a permanent line while preserving the mutable line below it. */
  writeLiveLine(text: string): void {
    this.clearLiveLine();
    this.#write(`${text}\n`);
  }

  clearLiveLine(): void {
    if (!this.#liveLineVisible) return;
    this.#write("\r\x1b[2K");
    this.#liveLineVisible = false;
  }

  updateLiveLine(text: string): void {
    if (!this.#liveMode || !this.#interactive()) return;
    this.#write(`\r\x1b[2K${text}`);
    this.#liveLineVisible = true;
  }

  leaveLiveMode(): void {
    this.clearLiveLine();
    this.#liveMode = false;
    if (this.#queue.length > 0) {
      this.#ensureTimer();
    } else {
      this.#showCursorIfIdle();
    }
  }

  /** Discards pending output and restores a stable terminal state. */
  cancel(): void {
    const resetStyles = this.#cursorHidden;
    const viewportEnding = this.#queue
      .find((item): item is ViewportItem => item.type === "viewport")
      ?.viewport.cancel();
    this.#generation += 1;
    this.#queue = [];
    this.#openViewport = undefined;
    this.#stopTimer();
    this.clearLiveLine();
    this.#liveMode = false;
    this.#liveModePending = false;
    this.#cursorHolds = 0;
    this.#resolveIdle();
    if (viewportEnding) this.#write(viewportEnding);
    if (resetStyles) this.#write("\x1b[0m");
    this.#showCursor();
  }

  #ensureTimer(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
  }

  #tick(): void {
    let remaining = Math.max(1, Math.round((this.#rate * TICK_MS) / 1_000));
    let output = "";
    let waitingForViewportInput = false;

    while (this.#queue.length > 0) {
      const item = this.#queue[0];
      if (!item) break;
      if (item.type === "instant") {
        output += item.text;
        this.#queue.shift();
        continue;
      }

      if (item.type === "viewport") {
        while (item.offset < item.units.length) {
          const unit = item.units[item.offset];
          if (!unit) break;
          if (unit.visible && remaining <= 0) break;
          item.offset += 1;
          // Compact rows are intentionally style-independent: generated SGR
          // tokens are dropped, then the viewport reapplies one muted style to
          // every complete row so redraws cannot inherit a stale ANSI state.
          if (!unit.visible) continue;
          item.viewport.append(unit);
          remaining -= 1;
        }
        output += item.viewport.redraw();

        if (item.offset >= item.units.length && !item.open) {
          output += item.viewport.finish();
          this.#queue.shift();
          continue;
        }
        if (item.offset >= item.units.length && item.open) {
          waitingForViewportInput = true;
        }
        break;
      }

      while (item.offset < item.units.length) {
        const unit = item.units[item.offset];
        if (!unit) break;
        if (unit.visible && remaining <= 0) break;
        output += unit.text;
        item.offset += 1;
        if (unit.visible) remaining -= 1;
      }

      if (item.offset >= item.units.length) {
        this.#queue.shift();
        continue;
      }
      break;
    }

    if (output !== "") this.#write(output);
    if (waitingForViewportInput) {
      this.#stopTimer();
      return;
    }
    if (this.#queue.length === 0) {
      this.#stopTimer();
      this.#resolveIdle();
      this.#showCursorIfIdle();
    }
  }

  #stopTimer(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #resolveIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #hideCursor(): void {
    if (!this.#interactive() || this.#cursorHidden) return;
    this.#write("\x1b[?25l");
    this.#cursorHidden = true;
  }

  #showCursorIfIdle(): void {
    if (this.#queue.length > 0 || this.#liveMode || this.#liveModePending || this.#cursorHolds > 0)
      return;
    this.#showCursor();
  }

  #showCursor(): void {
    if (!this.#interactive() || !this.#cursorHidden) return;
    this.#write("\x1b[?25h");
    this.#cursorHidden = false;
  }
}

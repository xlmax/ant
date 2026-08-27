export class InputHistory {
  #entries: string[] = [];
  #index: number | undefined;
  #draft = "";

  get isBrowsing(): boolean {
    return this.#index !== undefined;
  }

  add(value: string): void {
    if (value === "" || this.#entries.at(-1) === value) {
      return;
    }

    this.#entries.push(value);
    this.reset();
  }

  previous(current: string): string | undefined {
    if (this.#entries.length === 0) {
      return undefined;
    }

    if (this.#index === undefined) {
      this.#draft = current;
      this.#index = this.#entries.length;
    }

    this.#index = Math.max(0, this.#index - 1);
    return this.#entries[this.#index];
  }

  next(): string | undefined {
    if (this.#index === undefined) {
      return undefined;
    }

    if (this.#index >= this.#entries.length - 1) {
      const draft = this.#draft;
      this.reset();
      return draft;
    }

    this.#index += 1;
    return this.#entries[this.#index];
  }

  reset(): void {
    this.#index = undefined;
    this.#draft = "";
  }
}

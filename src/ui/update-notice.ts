import type { UpdateInfo } from "../updates/updates.js";
import { ansi } from "./ansi.js";
import { sectionFooter } from "./section.js";

export function formatUpdateNotice(info: UpdateInfo, currentVersion: string): string {
  return [
    sectionFooter(ansi.yellow),
    `Доступна новая версия ant: ${ansi.bold(ansi.cyan(`v${info.version}`))} (у вас ${currentVersion})`,
    `Обновиться глобально: ${ansi.cyan("/update")}`,
    sectionFooter(ansi.yellow),
  ].join("\n");
}
